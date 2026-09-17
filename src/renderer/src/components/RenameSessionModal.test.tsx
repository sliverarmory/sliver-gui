import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SliverDesktopAPI } from "../../../shared/contracts";
import type { SessionSummary, TargetCapabilityState } from "../../../shared/target-contracts";
import type { TargetOperationRecord } from "../../../shared/operation-contracts";
import { RenameSessionModal } from "./RenameSessionModal";

const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("@heroui/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@heroui/react")>();
  return { ...original, toast: { ...original.toast, success: toastSuccess } };
});

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});

beforeEach(() => toastSuccess.mockClear());
afterEach(() => cleanup());
afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

const session: SessionSummary = {
  mode: "session",
  id: "session-1",
  name: "payments",
  hostname: "test-host",
  hostId: "host-1",
  username: "alice",
  os: "darwin",
  arch: "arm64",
  transport: "mtls",
  remoteAddress: "127.0.0.1:4444",
  activeC2: "mtls://127.0.0.1:4444",
  executable: "/tmp/agent",
  version: "1.7.6",
  locale: "en-US",
  integrity: "High",
  burned: false,
  liveness: "active",
};
const capabilities: TargetCapabilityState[] = [{ id: "target.rename", available: true }];
const operation: TargetOperationRecord = {
  requestId: "request-1",
  operationId: "target.rename",
  target: { mode: "session", id: session.id, backendEpoch: 7, domainRevision: 3, fingerprint: "a".repeat(64) },
  targetName: session.name,
  backend: { configId: "config-1", configName: "Test", server: "127.0.0.1:53137", operator: "test", epoch: 7 },
  ownership: { origin: "local", ownerWindowId: 12, actor: { attribution: "verified", name: "test" } },
  mode: "session",
  state: "submitted",
  attempts: 1,
  createdAt: "2026-09-16T20:00:00.000Z",
  updatedAt: "2026-09-16T20:00:00.000Z",
};
type SubmitResult = Awaited<ReturnType<SliverDesktopAPI["submitTargetOperation"]>>;

function deferred(): { promise: Promise<SubmitResult>; resolve: (value: SubmitResult) => void } {
  let resolve!: (value: SubmitResult) => void;
  const promise = new Promise<SubmitResult>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function setup(submitTargetOperation = vi.fn<SliverDesktopAPI["submitTargetOperation"]>()) {
  vi.stubGlobal("sliver", { submitTargetOperation });
  const onClose = vi.fn();
  const onSubmitted = vi.fn(() => true);
  const props = { session, targetIdentity: "identity-1", capabilities, onClose, onSubmitted };
  return { ...render(<RenameSessionModal {...props} />), props, onClose, onSubmitted, submitTargetOperation };
}

describe("RenameSessionModal", () => {
  it("prefills the session name and submits only a trimmed name through the bound operation API", async () => {
    const user = userEvent.setup();
    const { submitTargetOperation, onClose, onSubmitted } = setup(vi.fn().mockResolvedValue({ ok: true, value: operation }));
    expect(screen.getByRole("dialog", { name: "Rename session" })).toBeVisible();
    expect(screen.getByText("Change the session name for test-host.")).toBeVisible();
    const input = screen.getByRole("textbox", { name: "Session name" });
    expect(input).toHaveValue("payments");
    expect(input).toHaveAttribute("maxlength", "32");
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    await user.clear(input);
    await user.type(input, "  payments-new  {Enter}");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(submitTargetOperation).toHaveBeenCalledExactlyOnceWith({ operationId: "target.rename", name: "payments-new" });
    expect(onSubmitted).toHaveBeenCalledExactlyOnceWith(operation);
    expect(toastSuccess).toHaveBeenCalledWith("Rename submitted", { description: "payments-new" });
  });

  it.each(["   ", "bad/name", ".", "..hidden", "x".repeat(33)])("rejects invalid session name %j before submission", (name) => {
    const { submitTargetOperation } = setup();
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: name } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/Use 1–32 letters, numbers/u);
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(submitTargetOperation).not.toHaveBeenCalled();
  });

  it("blocks duplicate submissions and dismissal while pending, and retains the draft after rejection", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const submitTargetOperation = vi.fn<SliverDesktopAPI["submitTargetOperation"]>().mockReturnValue(gate.promise);
    const { onClose, onSubmitted } = setup(submitTargetOperation);
    const input = screen.getByRole("textbox", { name: "Session name" });
    await user.clear(input);
    await user.type(input, "payments-new{Enter}");
    fireEvent.submit(input.closest("form")!);
    expect(submitTargetOperation).toHaveBeenCalledOnce();
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => gate.resolve({ ok: false, error: "Rename unavailable" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Rename unavailable");
    expect(input).toHaveValue("payments-new");
    expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("retains the draft and displays a transport rejection", async () => {
    const { onClose } = setup(vi.fn().mockRejectedValue(new Error("Connection lost")));
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "payments-new" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    expect(input).toHaveValue("payments-new");
    expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("merges a failed operation while showing its failure without a success notification", async () => {
    const failed: TargetOperationRecord = { ...operation, state: "failed", message: "Server rejected this name" };
    const { onSubmitted, onClose } = setup(vi.fn().mockResolvedValue({ ok: true, value: failed }));
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "payments-new" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Server rejected this name");
    expect(onSubmitted).toHaveBeenCalledExactlyOnceWith(failed);
    expect(input).toHaveValue("payments-new");
    expect(onClose).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it.each(["unmount", "identity change"])("ignores a late response after %s", async (change) => {
    const gate = deferred();
    const { props, rerender, unmount, onSubmitted, onClose } = setup(vi.fn().mockReturnValue(gate.promise));
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "payments-new" } });
    fireEvent.submit(input.closest("form")!);
    if (change === "unmount") unmount();
    else rerender(<RenameSessionModal {...props} session={{ ...session, name: "other" }} targetIdentity="identity-2" />);
    await act(async () => gate.resolve({ ok: true, value: operation }));
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    if (change === "identity change") {
      expect(screen.getByRole("textbox", { name: "Session name" })).toHaveValue("other");
      expect(screen.getByRole("textbox", { name: "Session name" })).toBeEnabled();
    }
  });

  it("ignores a response rejected by the owner's identity check", async () => {
    const { onSubmitted, onClose } = setup(vi.fn().mockResolvedValue({ ok: true, value: operation }));
    onSubmitted.mockReturnValue(false);
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "payments-new" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("blocks submission when the selected session cannot be renamed", () => {
    const { props, rerender, submitTargetOperation } = setup();
    rerender(<RenameSessionModal {...props} capabilities={[{
      id: "target.rename",
      available: false,
      reason: { code: "target-dead", message: "The session is no longer active." },
    }]} />);
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "payments-new" } });
    expect(screen.getByRole("alert")).toHaveTextContent("The session is no longer active.");
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(submitTargetOperation).not.toHaveBeenCalled();
  });
});
