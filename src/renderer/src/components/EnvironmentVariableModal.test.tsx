import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SliverDesktopAPI } from "../../../shared/contracts";
import { OPERATION_INPUT_LIMITS, type TargetOperationRecord } from "../../../shared/operation-contracts";
import type { SessionEnvironmentEntry } from "../../../shared/session-contracts";
import type { TargetCapabilityState } from "../../../shared/target-contracts";
import { EnvironmentVariableModal, type EnvironmentVariableModalProps } from "./EnvironmentVariableModal";

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

const capabilities: TargetCapabilityState[] = [{ id: "target.environment.write", available: true }];
const visibleEntry: SessionEnvironmentEntry = {
  name: "PATH",
  value: "/usr/bin",
  sensitive: false,
  redacted: false,
};
const redactedEntry: SessionEnvironmentEntry = {
  name: "API_TOKEN",
  sensitive: true,
  redacted: true,
};

function operation(overrides: Partial<TargetOperationRecord> = {}): TargetOperationRecord {
  return {
    requestId: "request-1",
    operationId: "target.env-set",
    target: { mode: "session", id: "session-1", backendEpoch: 7, domainRevision: 3, fingerprint: "a".repeat(64) },
    targetName: "payments",
    backend: { configId: "config-1", configName: "Test", server: "127.0.0.1:53137", operator: "test", epoch: 7 },
    ownership: { origin: "local", ownerWindowId: 12, actor: { attribution: "verified", name: "test" } },
    mode: "session",
    state: "completed",
    attempts: 1,
    createdAt: "2026-09-18T20:00:00.000Z",
    updatedAt: "2026-09-18T20:00:00.000Z",
    ...overrides,
  };
}

type SubmitResult = Awaited<ReturnType<SliverDesktopAPI["submitTargetOperation"]>>;

function deferred(): { promise: Promise<SubmitResult>; resolve: (value: SubmitResult) => void } {
  let resolve!: (value: SubmitResult) => void;
  const promise = new Promise<SubmitResult>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function setup(
  props: Pick<EnvironmentVariableModalProps, "mode" | "entry"> = { mode: "add" },
  submitTargetOperation = vi.fn<SliverDesktopAPI["submitTargetOperation"]>(),
) {
  vi.stubGlobal("sliver", { submitTargetOperation });
  const onClose = vi.fn();
  const onSubmitted = vi.fn(() => true);
  const modalProps = {
    ...props,
    targetIdentity: "identity-1",
    capabilities,
    onClose,
    onSubmitted,
  } as EnvironmentVariableModalProps;
  return {
    ...render(<EnvironmentVariableModal {...modalProps} />),
    props: modalProps,
    onClose,
    onSubmitted,
    submitTargetOperation,
  };
}

describe("EnvironmentVariableModal", () => {
  it("adds a variable with a trimmed name and an otherwise exact value", async () => {
    const submitTargetOperation = vi.fn<SliverDesktopAPI["submitTargetOperation"]>()
      .mockResolvedValue({ ok: true, value: operation() });
    const { onClose, onSubmitted } = setup({ mode: "add" }, submitTargetOperation);

    expect(screen.getByRole("dialog", { name: "Add environment variable" })).toBeVisible();
    const name = screen.getByRole("textbox", { name: "Variable name" });
    const value = screen.getByRole("textbox", { name: "Variable value" });
    expect(name).toHaveAttribute("maxlength", String(OPERATION_INPUT_LIMITS.environmentNameLength));
    expect(value).toHaveAttribute("maxlength", String(OPERATION_INPUT_LIMITS.environmentValueLength));
    fireEvent.change(name, { target: { value: "  HTTP_PROXY  " } });
    fireEvent.change(value, { target: { value: "  http://127.0.0.1:8080\n" } });
    fireEvent.submit(name.closest("form")!);

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(submitTargetOperation).toHaveBeenCalledExactlyOnceWith({
      operationId: "target.env-set",
      name: "HTTP_PROXY",
      value: "  http://127.0.0.1:8080\n",
    });
    expect(onSubmitted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: "request-1" }));
    expect(toastSuccess).toHaveBeenCalledWith("Environment variable added", { description: "HTTP_PROXY" });
  });

  it("prefills a visible value for editing while fixing the variable name", async () => {
    const submitTargetOperation = vi.fn<SliverDesktopAPI["submitTargetOperation"]>()
      .mockResolvedValue({ ok: true, value: operation() });
    setup({ mode: "edit", entry: visibleEntry }, submitTargetOperation);

    expect(screen.getByRole("dialog", { name: "Edit environment variable" })).toBeVisible();
    const name = screen.getByRole("textbox", { name: "Variable name" });
    const value = screen.getByRole("textbox", { name: "Variable value" });
    expect(name).toHaveValue("PATH");
    expect(name).toHaveAttribute("readonly");
    expect(value).toHaveValue("/usr/bin");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.change(name, { target: { value: "CHANGED" } });
    fireEvent.change(value, { target: { value: "/usr/local/bin" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Save changes" }));

    expect(submitTargetOperation).toHaveBeenCalledExactlyOnceWith({
      operationId: "target.env-set",
      name: "PATH",
      value: "/usr/local/bin",
    });
    expect(toastSuccess).toHaveBeenCalledWith("Environment variable updated", { description: "PATH" });
  });

  it("preserves the exact server-returned name while editing", async () => {
    const submitTargetOperation = vi.fn<SliverDesktopAPI["submitTargetOperation"]>()
      .mockResolvedValue({ ok: true, value: operation() });
    setup({
      mode: "edit",
      entry: { ...visibleEntry, name: " PATH " },
    }, submitTargetOperation);

    fireEvent.change(screen.getByRole("textbox", { name: "Variable value" }), {
      target: { value: "/usr/local/bin" },
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Save changes" }));

    expect(submitTargetOperation).toHaveBeenCalledExactlyOnceWith({
      operationId: "target.env-set",
      name: " PATH ",
      value: "/usr/local/bin",
    });
  });

  it("never prefills or reveals a redacted value and permits an intentional empty replacement", async () => {
    const submitTargetOperation = vi.fn<SliverDesktopAPI["submitTargetOperation"]>()
      .mockResolvedValue({ ok: true, value: operation() });
    setup({ mode: "edit", entry: redactedEntry }, submitTargetOperation);

    expect(screen.getByRole("textbox", { name: "Variable value" })).toHaveValue("");
    expect(screen.getByText(/current value is protected/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await userEvent.setup().type(screen.getByRole("textbox", { name: "Variable value" }), "replacement");
    await userEvent.setup().clear(screen.getByRole("textbox", { name: "Variable value" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Save changes" }));
    expect(submitTargetOperation).toHaveBeenCalledExactlyOnceWith({
      operationId: "target.env-set",
      name: "API_TOKEN",
      value: "",
    });
  });

  it.each([
    ["blank", "   "],
    ["equals sign", "BAD=NAME"],
    ["NUL", "BAD\0NAME"],
    ["oversized", "x".repeat(OPERATION_INPUT_LIMITS.environmentNameLength + 1)],
  ])("rejects a %s variable name before submission", (_label, invalidName) => {
    const { submitTargetOperation } = setup();
    const name = screen.getByRole("textbox", { name: "Variable name" });
    fireEvent.change(name, { target: { value: invalidName } });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Add variable" })).toBeDisabled();
    fireEvent.submit(name.closest("form")!);
    expect(submitTargetOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["NUL", "bad\0value"],
    ["oversized", "x".repeat(OPERATION_INPUT_LIMITS.environmentValueLength + 1)],
  ])("rejects a %s variable value before submission", (_label, invalidValue) => {
    const { submitTargetOperation } = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Variable name" }), { target: { value: "VALID" } });
    const value = screen.getByRole("textbox", { name: "Variable value" });
    fireEvent.change(value, { target: { value: invalidValue } });
    expect(value).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Add variable" })).toBeDisabled();
    expect(submitTargetOperation).not.toHaveBeenCalled();
  });

  it("blocks duplicate submission and dismissal while pending, then retains the draft after rejection", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const submitTargetOperation = vi.fn<SliverDesktopAPI["submitTargetOperation"]>().mockReturnValue(gate.promise);
    const { onClose, onSubmitted } = setup({ mode: "add" }, submitTargetOperation);
    const name = screen.getByRole("textbox", { name: "Variable name" });
    const value = screen.getByRole("textbox", { name: "Variable value" });
    await user.type(name, "HTTP_PROXY");
    await user.type(value, "proxy-value");
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.submit(name.closest("form")!);

    expect(submitTargetOperation).toHaveBeenCalledOnce();
    expect(name).toBeDisabled();
    expect(value).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => gate.resolve({ ok: false, error: "Environment unavailable" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Environment unavailable");
    expect(name).toHaveValue("HTTP_PROXY");
    expect(value).toHaveValue("proxy-value");
    expect(screen.getByRole("button", { name: "Add variable" })).toBeEnabled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it.each(["failed", "canceled", "partial", "outcome-unknown", "target-disappeared"] as const)(
    "merges a %s operation while retaining the modal as an error",
    async (state) => {
      const failed = operation({ state, message: `Operation ${state}` });
      const { onClose, onSubmitted } = setup(
        { mode: "edit", entry: visibleEntry },
        vi.fn().mockResolvedValue({ ok: true, value: failed }),
      );
      fireEvent.change(screen.getByRole("textbox", { name: "Variable value" }), {
        target: { value: "/usr/local/bin" },
      });
      await userEvent.setup().click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(`Operation ${state}`);
      expect(onSubmitted).toHaveBeenCalledExactlyOnceWith(failed);
      expect(onClose).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
    },
  );

  it("blocks submission when environment changes are unavailable", () => {
    const { props, rerender, submitTargetOperation } = setup();
    rerender(<EnvironmentVariableModal
      {...props}
      capabilities={[{
        id: "target.environment.write",
        available: false,
        reason: { code: "target-dead", message: "The session is no longer active." },
      }]}
    />);
    fireEvent.change(screen.getByRole("textbox", { name: "Variable name" }), { target: { value: "VALID" } });
    expect(screen.getByRole("alert")).toHaveTextContent("The session is no longer active.");
    expect(screen.getByRole("button", { name: "Add variable" })).toBeDisabled();
    expect(submitTargetOperation).not.toHaveBeenCalled();
  });

  it("ignores a late response after the target identity changes", async () => {
    const gate = deferred();
    const { props, rerender, onClose, onSubmitted } = setup(
      { mode: "add" },
      vi.fn().mockReturnValue(gate.promise),
    );
    const name = screen.getByRole("textbox", { name: "Variable name" });
    fireEvent.change(name, { target: { value: "FIRST" } });
    fireEvent.submit(name.closest("form")!);
    rerender(<EnvironmentVariableModal {...props} targetIdentity="identity-2" />);

    await act(async () => gate.resolve({ ok: true, value: operation() }));
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Variable name" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Add variable" })).toBeDisabled();
  });
});
