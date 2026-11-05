import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRendererTestEnvironment } from "../../../tests/renderer-test-helpers";

import type { ExecutionActionDraft, ExecutionCapability, ProcessExecutionRecord } from "../../../shared/execution-contracts";
import type { SessionSummary } from "../../../shared/target-contracts";
import { renderWithApplicationContextMenu as render } from "../application-context-menu-test-utils";
import { ProcessExecutionView } from "./ProcessExecutionView";

vi.mock("../components/ExecutionOutputTerminal", () => ({
  ExecutionOutputTerminal: ({ bytes }: { bytes: Uint8Array }) => (
    <pre aria-label="Execution output transcript">{new TextDecoder().decode(bytes)}</pre>
  ),
}));

useRendererTestEnvironment({ pointerCapture: true });

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

describe("Process execution actions", () => {
  it("prepares an execution from the composer action", async () => {
    const user = userEvent.setup();
    const { onPrepare } = renderView();
    const composer = screen.getByRole("region", { name: "Execute a subprocess" });

    await user.click(within(composer).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
    expect(onPrepare).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "execution.process", path: "/bin/sh", captureOutput: true,
    }));
  });

  it("clears the selected execution from its result action", async () => {
    const user = userEvent.setup();
    const { onClear } = renderView([completed], completed.id);
    const workspace = screen.getByRole("region", { name: "Process execution history and output" });

    expect(within(workspace).getByLabelText("Execution output transcript")).toHaveTextContent("hello");
    await user.click(within(workspace).getByRole("button", { name: "Clear selected" }));
    expect(onClear).toHaveBeenCalledExactlyOnceWith(completed.id);
  });
});
