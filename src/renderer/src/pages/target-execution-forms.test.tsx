import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ExecutionActionDraft, ExecutionCapability } from "../../../shared/execution-contracts";
import type { SessionSummary } from "../../../shared/target-contracts";
import { ExecutionActionForm } from "./target-execution-forms";

const capability: ExecutionCapability = {
  operationId: "execution.process",
  available: true,
  modes: ["session"],
  platforms: ["linux", "windows"],
  risk: "mutating",
  confirmationRequired: true,
  credentialBearing: false,
  artifacts: [],
};

const linuxTarget: SessionSummary = {
  mode: "session",
  id: "session-1",
  name: "host",
  hostname: "host",
  hostId: "host-1",
  username: "operator",
  os: "linux",
  arch: "amd64",
  transport: "mtls",
  remoteAddress: "127.0.0.1:4444",
  activeC2: "mtls://127.0.0.1:4444",
  executable: "/tmp/implant",
  version: "1.0.0",
  locale: "en-US",
  integrity: "user",
  burned: false,
  liveness: "active",
};

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

function renderCompact(target: SessionSummary = linuxTarget): {
  onPrepare: ReturnType<typeof vi.fn<(draft: ExecutionActionDraft) => Promise<void>>>;
} {
  const onPrepare = vi.fn(async (_draft: ExecutionActionDraft) => undefined);
  render(
    <>
      <ExecutionActionForm
        capability={capability}
        compactProcess
        formId="process-test-form"
        isPreparing={false}
        operationId="execution.process"
        target={target}
        onPrepare={onPrepare}
      />
      <button form="process-test-form" type="submit">Review</button>
    </>,
  );
  return { onPrepare };
}

describe("compact process execution form", () => {
  it.each([
    { os: "windows", path: "C:\\Windows\\System32\\cmd.exe" },
    { os: "linux", path: "/bin/sh" },
    { os: "darwin", path: "/bin/sh" },
  ])("defaults the executable path for $os", ({ os, path }) => {
    renderCompact({ ...linuxTarget, os });
    expect(screen.getByRole("textbox", { name: "Executable path" })).toHaveValue(path);
  });

  it("keeps only path and arguments inline and defaults to captured foreground output", async () => {
    const user = userEvent.setup();
    const { onPrepare } = renderCompact();
    expect(screen.getByRole("textbox", { name: "Executable path" })).toBeInTheDocument();
    const argumentsField = screen.getByRole("textbox", { name: "Arguments" });
    expect(argumentsField.tagName).toBe("INPUT");
    expect(screen.queryByRole("switch", { name: /Capture output/u })).not.toBeInTheDocument();

    const executable = screen.getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/bin/echo");
    await user.type(argumentsField, 'first "two words" three\\ four ""');
    await user.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
    expect(onPrepare).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "execution.process",
      path: "/bin/echo",
      args: ["first", "two words", "three four", ""],
      captureOutput: true,
      background: false,
    }));
  });

  it("rejects malformed argument quoting before preparing a command and recovers after correction", async () => {
    const user = userEvent.setup();
    const { onPrepare } = renderCompact();
    const argumentsField = screen.getByRole("textbox", { name: "Arguments" });
    const executable = screen.getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/bin/echo");
    await user.type(argumentsField, '"unfinished');
    await user.click(screen.getByRole("button", { name: "Review" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/quote/iu);
    expect(onPrepare).not.toHaveBeenCalled();

    await user.clear(argumentsField);
    await user.type(argumentsField, '"finished value"');
    await user.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
    expect(onPrepare).toHaveBeenCalledWith(expect.objectContaining({ args: ["finished value"] }));
  });

  it("retains modal options after closing and submits them through typed draft validation", async () => {
    const user = userEvent.setup();
    const { onPrepare } = renderCompact();
    const executable = screen.getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/bin/echo");
    await user.click(screen.getByRole("button", { name: "Execution options" }));
    const modal = await screen.findByRole("dialog", { name: "Execution options" });
    expect(within(modal).getByRole("switch", { name: /Capture output/u })).toBeChecked();
    await user.click(within(modal).getByRole("switch", { name: /Run in background/u }));
    expect(within(modal).getByRole("switch", { name: /Capture output/u })).not.toBeChecked();
    await user.click(within(modal).getByRole("switch", { name: /Inherit environment/u }));
    await user.type(within(modal).getByRole("textbox", { name: "Environment overrides" }), "LANG=C");
    await user.clear(within(modal).getByRole("spinbutton", { name: "Timeout seconds" }));
    await user.type(within(modal).getByRole("spinbutton", { name: "Timeout seconds" }), "27");
    await user.type(within(modal).getByRole("textbox", { name: "Remote stdout path" }), "/tmp/out.txt");
    await user.click(within(modal).getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: "Execution options" }));
    const reopened = await screen.findByRole("dialog", { name: "Execution options" });
    expect(within(reopened).getByRole("switch", { name: /Run in background/u })).toBeChecked();
    expect(within(reopened).getByRole("textbox", { name: "Environment overrides" })).toHaveValue("LANG=C");
    await user.click(within(reopened).getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
    expect(onPrepare).toHaveBeenCalledWith(expect.objectContaining({
      background: true,
      captureOutput: false,
      inheritEnvironment: true,
      environment: [{ name: "LANG", value: "C" }],
      timeoutSeconds: 27,
      stdoutPath: "/tmp/out.txt",
    }));
  });

  it("exposes Windows token and parent controls only for Windows", async () => {
    const user = userEvent.setup();
    const windowsTarget: SessionSummary = { ...linuxTarget, os: "windows", arch: "amd64" };
    const { onPrepare } = renderCompact(windowsTarget);
    expect(screen.getByRole("textbox", { name: "Executable path" })).toHaveValue("C:\\Windows\\System32\\cmd.exe");
    await user.click(screen.getByRole("button", { name: "Execution options" }));
    const modal = await screen.findByRole("dialog", { name: "Execution options" });
    await user.click(within(modal).getByRole("switch", { name: /Use current token/u }));
    await user.type(within(modal).getByRole("spinbutton", { name: "Parent process ID" }), "1234");
    await user.click(within(modal).getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
    expect(onPrepare).toHaveBeenCalledWith(expect.objectContaining({
      useToken: true,
      parentPid: 1234,
    }));
  });
});

describe("noncompact process execution form", () => {
  it.each([
    { os: "windows", path: "C:\\Windows\\System32\\cmd.exe" },
    { os: "linux", path: "/bin/sh" },
    { os: "darwin", path: "/bin/sh" },
  ])("defaults the executable path for $os", ({ os, path }) => {
    const onPrepare = vi.fn(async (_draft: ExecutionActionDraft) => undefined);
    render(
      <ExecutionActionForm
        capability={capability}
        formId="noncompact-process-test-form"
        isPreparing={false}
        operationId="execution.process"
        target={{ ...linuxTarget, os }}
        onPrepare={onPrepare}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Executable path" })).toHaveValue(path);
  });
});
