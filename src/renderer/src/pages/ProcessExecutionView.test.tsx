import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ExecutionActionDraft, ExecutionCapability, ProcessExecutionRecord } from "../../../shared/execution-contracts";
import type { SessionSummary } from "../../../shared/target-contracts";
import { renderWithApplicationContextMenu as render } from "../application-context-menu-test-utils";
import { ProcessExecutionView } from "./ProcessExecutionView";

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

afterEach(cleanup);

const target: SessionSummary = {
  mode: "session", id: "process-session", name: "target", hostname: "target", hostId: "host-1", username: "operator",
  os: "linux", arch: "amd64", transport: "mtls", remoteAddress: "10.0.0.8:4444",
  activeC2: "mtls://10.0.0.8:4444", executable: "/tmp/sliver", version: "1.7.6",
  locale: "en-US", integrity: "user", burned: false, liveness: "active",
};

const capability: ExecutionCapability = {
  operationId: "execution.process", available: true, modes: ["session"], platforms: ["linux"],
  risk: "mutating", confirmationRequired: true, credentialBearing: false, artifacts: [],
};

const completed: ProcessExecutionRecord = {
  id: "run-1", startedAt: "2026-09-25T11:00:00.000Z", path: "/bin/echo", args: ["hello"], state: "completed",
  result: {
    requestId: "request-1", operationId: "execution.process", state: "completed",
    message: "Process execution completed.", pid: 42, exitCode: 0,
  },
  stdout: { data: new TextEncoder().encode("hello\n"), truncated: false },
};

function renderView(history: readonly ProcessExecutionRecord[] = [], selectedId: string | null = null): {
  onPrepare: ReturnType<typeof vi.fn<(draft: ExecutionActionDraft) => Promise<void>>>;
  onClear: ReturnType<typeof vi.fn<(id: string) => void>>;
} {
  const onPrepare = vi.fn(async (_draft: ExecutionActionDraft) => undefined);
  const onClear = vi.fn<(id: string) => void>();
  render(
    <ProcessExecutionView
      capability={capability}
      target={target}
      isPreparing={false}
      isExecuting={false}
      isRefreshing={false}
      history={history}
      selectedId={selectedId}
      savingStream={undefined}
      addingToLoot={false}
      onPrepare={onPrepare}
      onSelect={vi.fn()}
      onClear={onClear}
      onClearAll={vi.fn()}
      onRefresh={vi.fn()}
      onSave={vi.fn()}
      onAddToLoot={vi.fn()}
    />,
  );
  return { onPrepare, onClear };
}

describe("Process execution scroll layout", () => {
  it("keeps the new execution title and Execute action above the shadowed form scrollport", async () => {
    const user = userEvent.setup();
    const { onPrepare } = renderView();
    const composer = screen.getByRole("region", { name: "Execute a subprocess" });
    const scrollport = within(composer).getByRole("region", { name: "Process execution content" });
    const header = within(composer).getByRole("heading", { name: "Execute a subprocess" }).closest("header");
    const execute = within(composer).getByRole("button", { name: "Execute" });

    expect(header).not.toBeNull();
    expect(header).toHaveClass("sticky", "top-0", "z-10");
    expect(header).toContainElement(execute);
    expect(scrollport).not.toContainElement(header);
    expect(scrollport).toContainElement(within(composer).getByRole("textbox", { name: "Executable path" }));
    expect(scrollport).toHaveClass("scroll-shadow", "scroll-shadow--vertical", "min-h-0", "flex-1", "overflow-y-auto");
    expect(scrollport).toHaveAttribute("data-scroll-shadow-size", "24");
    expect(scrollport).toHaveAttribute("tabindex", "0");

    await user.click(execute);
    await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
  });

  it("keeps a selected result title and Clear action above the shadowed details and output", async () => {
    const user = userEvent.setup();
    const { onClear } = renderView([completed], completed.id);
    const workspace = screen.getByRole("region", { name: "Process execution history and output" });
    const scrollport = within(workspace).getByRole("region", { name: "Process execution content" });
    const header = within(workspace).getByRole("heading", { name: "/bin/echo hello" }).closest("header");
    const clear = within(workspace).getByRole("button", { name: "Clear selected" });

    expect(header).not.toBeNull();
    expect(header).toHaveClass("sticky", "top-0", "z-10");
    expect(header).toContainElement(clear);
    expect(scrollport).not.toContainElement(header);
    expect(scrollport).toContainElement(within(workspace).getByLabelText("Execution details"));
    expect(scrollport).toContainElement(within(workspace).getByRole("group", { name: "Output actions" }));
    expect(scrollport).toHaveClass("scroll-shadow", "scroll-shadow--vertical", "min-h-0", "flex-1", "overflow-y-auto");

    await user.click(clear);
    expect(onClear).toHaveBeenCalledWith(completed.id);
  });
});
