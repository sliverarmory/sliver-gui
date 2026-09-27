import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
  type ApplicationSettingsState,
} from "../../../shared/application-settings-contracts";
import type { BeaconTaskDetail } from "../../../shared/operation-contracts";
import type { GhosttyTerminalProps } from "../components/GhosttyTerminal";
import type { ExecutionOutputTransport } from "../components/ExecutionOutputTerminal";

const terminal = vi.hoisted(() => ({ props: undefined as GhosttyTerminalProps | undefined }));

vi.mock("../components/GhosttyTerminal", () => ({
  GhosttyTerminal: (props: GhosttyTerminalProps) => {
    terminal.props = props;
    return <div aria-label={props.ariaLabel} />;
  },
}));

import { ApplicationSettingsProvider, type ApplicationSettingsAPI } from "../components/ApplicationSettingsProvider";
import { BeaconExecutionTaskOutput } from "./BeaconExecutionTaskOutput";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let getTerminalRuntime: ReturnType<typeof vi.fn>;

function task(overrides: Partial<BeaconTaskDetail> = {}): BeaconTaskDetail {
  return {
    taskId: "execute-1",
    beaconId: "beacon-1",
    state: "completed",
    description: "ExecuteReq",
    resultAvailable: true,
    cancellation: { available: false },
    ownership: { origin: "external", actor: { attribution: "unknown" } },
    execution: {
      operationId: "execution.process",
      pid: 4321,
      exitCode: 0,
      stdout: { data: encoder.encode("stdout output\n"), truncated: false },
      stderr: { data: encoder.encode("stderr output\n"), truncated: false },
    },
    ...overrides,
  };
}

function subscribeToOutput(): ReturnType<typeof vi.fn> {
  const onOutput = vi.fn();
  terminal.props!.transport.subscribe({ onOutput, onClose: vi.fn() });
  terminal.props!.onReady?.();
  return onOutput;
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  getTerminalRuntime = vi.fn(async () => ({
    ok: true as const,
    value: { version: "0.4.0" as const, sha256: "a".repeat(64), bytes: Uint8Array.of(0, 97, 115, 109) },
  }));
  vi.stubGlobal("sliver", { getTerminalRuntime });
});

afterEach(() => {
  cleanup();
  terminal.props = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-reduce-motion");
  document.documentElement.style.colorScheme = "";
});

describe("BeaconExecutionTaskOutput", () => {
  it("mounts Ghostty only near the output viewport and replays refreshed bytes after an offscreen unmount", async () => {
    const observers = installIntersectionObservers();
    const view = (value: BeaconTaskDetail) => (
      <div aria-label="Beacon task outputs"><article data-task-id={value.taskId} tabIndex={-1}><BeaconExecutionTaskOutput task={value} /></article></div>
    );
    const { rerender, unmount } = render(view(task()));
    const viewport = screen.getByLabelText("Beacon task outputs");
    const observer = observers[0]!;
    expect(observer.options).toMatchObject({ root: viewport, rootMargin: "200px 0px", threshold: 0 });
    expect(observer.target).toHaveClass("h-64");
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("stdout output");
    expect(screen.queryByLabelText("Execution output terminal")).not.toBeInTheDocument();
    expect(getTerminalRuntime).not.toHaveBeenCalled();

    act(() => observer.emit(true));
    await screen.findByLabelText("Execution output terminal");
    const firstTransport = terminal.props!.transport as ExecutionOutputTransport;
    const firstOutput = subscribeToOutput();
    expect(getTerminalRuntime).toHaveBeenCalledOnce();
    act(() => observer.emit(false));
    expect(screen.queryByLabelText("Execution output terminal")).not.toBeInTheDocument();
    firstTransport.ready();
    expect(firstOutput).toHaveBeenCalledOnce();

    rerender(view(task({ execution: {
      operationId: "execution.process", stdout: { data: encoder.encode("updated offscreen output"), truncated: false },
    } })));
    expect(observers).toHaveLength(1);
    expect(observer.disconnect).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("updated offscreen output");
    expect(getTerminalRuntime).toHaveBeenCalledOnce();
    act(() => observer.emit(true));
    await screen.findByLabelText("Execution output terminal");
    expect(terminal.props!.transport).not.toBe(firstTransport);
    expect(decoder.decode(subscribeToOutput().mock.calls[0]![0])).toBe("updated offscreen output");
    expect(getTerminalRuntime).toHaveBeenCalledTimes(2);

    rerender(view(task({ taskId: "execute-next", execution: {
      operationId: "execution.assembly", stdout: { data: encoder.encode("next assembly"), truncated: false },
    } })));
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(observers).toHaveLength(2);
    expect(screen.queryByLabelText("Execution output terminal")).not.toBeInTheDocument();
    act(() => observer.emit(true));
    expect(screen.queryByLabelText("Execution output terminal")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("next assembly");
    unmount();
    expect(observers[1]!.disconnect).toHaveBeenCalledOnce();
  });

  it("immediately remounts an offscreen output when queue navigation focuses its article", async () => {
    const observers = installIntersectionObservers();
    render(<div aria-label="Beacon task outputs"><article aria-label="Task output execute-1" data-task-id="execute-1" tabIndex={-1}><BeaconExecutionTaskOutput task={task()} /></article></div>);
    expect(screen.queryByLabelText("Execution output terminal")).not.toBeInTheDocument();
    act(() => screen.getByRole("article", { name: "Task output execute-1" }).focus());
    await screen.findByLabelText("Execution output terminal");
    expect(screen.getByRole("article", { name: "Task output execute-1" })).toHaveFocus();
    expect(decoder.decode(subscribeToOutput().mock.calls[0]![0])).toBe("stdout output\r\n");
    act(() => observers[0]!.emit(false));
    expect(screen.queryByLabelText("Execution output terminal")).not.toBeInTheDocument();
  });

  it("renders independent captured streams in read-only Ghostty and copies the selected stream", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const stdout = encoder.encode("\u001b[32mstdout output\u001b[0m\n");
    const stderr = encoder.encode("stderr output\n");
    render(<BeaconExecutionTaskOutput task={task({ execution: {
      operationId: "execution.process", pid: 4321, exitCode: 7,
      stdout: { data: stdout, truncated: false },
      stderr: { data: stderr, truncated: true },
    } })} />);

    await screen.findByLabelText("Execution output terminal");
    expect(screen.getByText("PID").nextElementSibling).toHaveTextContent("4321");
    expect(screen.getByText("Exit code").nextElementSibling).toHaveTextContent("7");
    expect(terminal.props).toMatchObject({ disableInput: true, enableClipboard: true });
    expect(screen.getByRole("radio", { name: "Stdout" })).toBeChecked();
    const stdoutTransport = terminal.props!.transport;
    const stdoutOutput = subscribeToOutput();
    expect(decoder.decode(stdoutOutput.mock.calls[0]![0])).toBe("\u001b[32mstdout output\u001b[0m\r\n");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(writeText).toHaveBeenLastCalledWith(decoder.decode(stdout));
    await user.click(screen.getByRole("radio", { name: "Stderr" }));
    expect(terminal.props!.transport).not.toBe(stdoutTransport);
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("stderr output");
    expect(screen.getByRole("note")).toHaveTextContent("The captured stderr was truncated at the output limit.");
    const stderrOutput = subscribeToOutput();
    expect(decoder.decode(stderrOutput.mock.calls[0]![0])).toBe("stderr output\r\n");
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(writeText).toHaveBeenLastCalledWith(decoder.decode(stderr));
    expect(stdout).toEqual(encoder.encode("\u001b[32mstdout output\u001b[0m\n"));
  });

  it.each([
    "execution.assembly", "bof.execute", "execution.sideload", "execution.spawn-dll", "privilege.run-as",
  ] as const)("renders %s output with the shared terminal rather than a text preview", async (operationId) => {
    render(<BeaconExecutionTaskOutput task={task({ execution: {
      operationId, stdout: { data: encoder.encode(`${operationId} result\n`), truncated: false },
    } })} />);

    await screen.findByLabelText("Execution output terminal");
    const onOutput = subscribeToOutput();
    expect(decoder.decode(onOutput.mock.calls[0]![0])).toBe(`${operationId} result\r\n`);
    expect(screen.queryByText("PID")).not.toBeInTheDocument();
    expect(screen.queryByText("Exit code")).not.toBeInTheDocument();
  });

  it("retains binary BOF bytes and exposes invalid UTF-8 as replacement characters in its transcript", async () => {
    const binary = Uint8Array.of(65, 0, 255, 66);
    render(<BeaconExecutionTaskOutput task={task({ execution: {
      operationId: "bof.execute", stdout: { data: binary, truncated: true },
    } })} />);

    await screen.findByLabelText("Execution output terminal");
    const onOutput = subscribeToOutput();
    expect(onOutput.mock.calls[0]![0]).toEqual(binary);
    expect(screen.getByLabelText("Execution output transcript").textContent).toContain("�B");
    expect(screen.getByRole("note")).toHaveTextContent("captured stdout was truncated");
    expect(binary).toEqual(Uint8Array.of(65, 0, 255, 66));
  });

  it("replaces a refreshed result without appending stale output and resets the stream for another task", async () => {
    const user = userEvent.setup();
    const first = task();
    const { rerender } = render(<BeaconExecutionTaskOutput task={first} />);
    await screen.findByLabelText("Execution output terminal");
    await user.click(screen.getByRole("radio", { name: "Stderr" }));
    const onOutput = subscribeToOutput();
    const stderrTransport = terminal.props!.transport;

    rerender(<BeaconExecutionTaskOutput task={task({ execution: {
      ...first.execution!, stderr: { data: encoder.encode("refreshed stderr"), truncated: false },
    } })} />);
    expect(terminal.props!.transport).toBe(stderrTransport);
    expect(onOutput.mock.calls.map(([bytes]) => decoder.decode(bytes))).toEqual([
      "stderr output\r\n", "\u001bc", "refreshed stderr",
    ]);
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("refreshed stderr");

    rerender(<BeaconExecutionTaskOutput task={task({ taskId: "execute-2", execution: {
      operationId: "execution.process", stdout: { data: encoder.encode("next task stdout"), truncated: false },
    } })} />);
    await screen.findByLabelText("Execution output terminal");
    expect(screen.getByRole("radio", { name: "Stdout" })).toBeChecked();
    expect(terminal.props!.transport).not.toBe(stderrTransport);
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("next task stdout");
    expect(screen.getByLabelText("Execution output transcript")).not.toHaveTextContent("refreshed stderr");
  });

  it.each([
    ["pending", "Waiting for the beacon execution result."],
    ["sent", "Waiting for the beacon execution result."],
    ["canceled", "The task was canceled. No stdout was captured."],
    ["failed", "The task failed. No stdout was captured."],
    ["completed", "No stdout was returned for this task."],
  ] as const)("reports %s without inventing captured output", (state, message) => {
    render(<BeaconExecutionTaskOutput task={task({ state, execution: { operationId: "execution.process" } })} />);

    expect(screen.getByRole("status")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Copy output" })).toBeDisabled();
    expect(screen.queryByLabelText("Execution output terminal")).not.toBeInTheDocument();
    expect(getTerminalRuntime).not.toHaveBeenCalled();
  });

  it("preserves a captured stream when another output is unavailable", async () => {
    const user = userEvent.setup();
    render(<BeaconExecutionTaskOutput task={task({ execution: {
      operationId: "execution.process", outputError: "The stderr output could not be retained.",
      stdout: { data: encoder.encode("retained stdout"), truncated: false },
    } })} />);

    await screen.findByLabelText("Execution output terminal");
    expect(screen.getByRole("alert")).toHaveTextContent("The stderr output could not be retained.");
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("retained stdout");
    await user.click(screen.getByRole("radio", { name: "Stderr" }));
    expect(screen.getByRole("status")).toHaveTextContent("Captured stderr is unavailable.");
    expect(screen.getByRole("button", { name: "Copy output" })).toBeDisabled();
  });

  it("updates font and theme from live application settings without replacing the output transport", async () => {
    let publish: ((settings: ApplicationSettingsState) => void) | undefined;
    const initial: ApplicationSettingsState = {
      ...DEFAULT_APPLICATION_SETTINGS_STATE, revision: 1, theme: "dark", reduceMotion: false,
      terminal: { ...DEFAULT_APPLICATION_SETTINGS_STATE.terminal, fontId: "jetbrains-mono", fontSize: 18 },
    };
    const api: ApplicationSettingsAPI = {
      getApplicationSettings: vi.fn(async () => initial),
      onApplicationSettingsChanged: (listener) => { publish = listener; return vi.fn(); },
    };
    render(<ApplicationSettingsProvider api={api}><BeaconExecutionTaskOutput task={task()} /></ApplicationSettingsProvider>);
    await screen.findByLabelText("Execution output terminal");
    await waitFor(() => expect(terminal.props!.appearance).toMatchObject({
      fontFamily: '"JetBrains Mono", monospace', fontSize: 18, cursorBlink: false,
      theme: { background: "#1e1e1e" },
    }));
    const transport = terminal.props!.transport;
    const onOutput = subscribeToOutput();

    act(() => publish!({
      ...initial, revision: 2, theme: "light",
      terminal: { ...initial.terminal, fontId: "cascadia-mono", fontSize: 22 },
    }));

    await waitFor(() => expect(terminal.props!.appearance).toMatchObject({
      fontFamily: '"Cascadia Mono", monospace', fontSize: 22,
      theme: { background: "#fafafa" },
    }));
    expect(terminal.props!.transport).toBe(transport);
    expect(getTerminalRuntime).toHaveBeenCalledOnce();
    expect(onOutput).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("stdout output");
  });

  it("keeps the transcript available when the verified terminal runtime is unavailable", async () => {
    getTerminalRuntime.mockResolvedValueOnce({ ok: false, error: "Terminal runtime unavailable" });
    render(<BeaconExecutionTaskOutput task={task()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Terminal runtime unavailable");
    expect(screen.queryByLabelText("Execution output terminal")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("stdout output");
  });
});

function installIntersectionObservers(): Array<{
  target: Element | undefined;
  options: IntersectionObserverInit | undefined;
  disconnect: ReturnType<typeof vi.fn>;
  emit: (isIntersecting: boolean) => void;
}> {
  const records: ReturnType<typeof installIntersectionObservers> = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      const record = {
        target: undefined as Element | undefined,
        options,
        disconnect: vi.fn(),
        emit: (isIntersecting: boolean) => callback([{ target: record.target!, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
      };
      this.observe = (target: Element) => { record.target = target; };
      this.disconnect = record.disconnect;
      records.push(record);
    }
    observe: (target: Element) => void;
    disconnect: () => void;
  });
  return records;
}
