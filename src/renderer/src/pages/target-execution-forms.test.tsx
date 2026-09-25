import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
  type ApplicationSettingsState,
} from "../../../shared/application-settings-contracts";
import type { ExecutionActionDraft, ExecutionCapability } from "../../../shared/execution-contracts";
import type { SessionSummary } from "../../../shared/target-contracts";
import { ApplicationSettingsProvider, type ApplicationSettingsAPI } from "../components/ApplicationSettingsProvider";
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
  it("uses the selected terminal font for the executable and argument inputs, including later changes", async () => {
    const initialSettings: ApplicationSettingsState = {
      ...DEFAULT_APPLICATION_SETTINGS_STATE,
      revision: 1,
      terminal: { ...DEFAULT_APPLICATION_SETTINGS_STATE.terminal, fontId: "jetbrains-mono" },
    };
    let onSettingsChanged: ((state: ApplicationSettingsState) => void) | undefined;
    const api: ApplicationSettingsAPI = {
      getApplicationSettings: vi.fn(async () => initialSettings),
      onApplicationSettingsChanged: vi.fn((listener) => {
        onSettingsChanged = listener;
        return () => undefined;
      }),
    };
    render(
      <ApplicationSettingsProvider api={api}>
        <ExecutionActionForm
          capability={capability}
          compactProcess
          formId="process-font-test-form"
          isPreparing={false}
          operationId="execution.process"
          target={linuxTarget}
          onPrepare={vi.fn(async (_draft: ExecutionActionDraft) => undefined)}
        />
      </ApplicationSettingsProvider>,
    );

    const executable = screen.getByRole("textbox", { name: "Executable path" });
    const argumentsField = screen.getByRole("textbox", { name: "Arguments" });
    await waitFor(() => {
      expect(executable).toHaveStyle({ fontFamily: '"JetBrains Mono", monospace' });
      expect(argumentsField).toHaveStyle({ fontFamily: '"JetBrains Mono", monospace' });
    });

    act(() => onSettingsChanged?.({
      ...initialSettings,
      revision: 2,
      terminal: { ...initialSettings.terminal, fontId: "cascadia-mono" },
    }));
    expect(executable).toHaveStyle({ fontFamily: '"Cascadia Mono", monospace' });
    expect(argumentsField).toHaveStyle({ fontFamily: '"Cascadia Mono", monospace' });
  });

  it.each([
    { os: "windows", path: "C:\\Windows\\System32\\cmd.exe" },
    { os: "linux", path: "/bin/sh" },
    { os: "darwin", path: "/bin/sh" },
  ])("defaults the executable path for $os", ({ os, path }) => {
    renderCompact({ ...linuxTarget, os });
    expect(screen.getByRole("textbox", { name: "Executable path" })).toHaveValue(path);
  });

  it("keeps path, arguments, and options inline and defaults to captured foreground output", async () => {
    const user = userEvent.setup();
    const { onPrepare } = renderCompact();
    expect(screen.getByRole("textbox", { name: "Executable path" })).toBeInTheDocument();
    const argumentsField = screen.getByRole("textbox", { name: "Arguments" });
    expect(argumentsField.tagName).toBe("INPUT");
    expect(screen.getByRole("switch", { name: /Capture output/u })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Run in background/u })).not.toBeChecked();
    expect(screen.queryByRole("dialog", { name: "Execution options" })).not.toBeInTheDocument();

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

  it("submits inline options through typed draft validation", async () => {
    const user = userEvent.setup();
    const { onPrepare } = renderCompact();
    const executable = screen.getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, "/bin/echo");
    expect(screen.getByRole("switch", { name: /Capture output/u })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: /Run in background/u }));
    expect(screen.getByRole("switch", { name: /Capture output/u })).not.toBeChecked();
    await user.click(screen.getByRole("switch", { name: /Inherit environment/u }));
    await user.type(screen.getByRole("textbox", { name: "Environment overrides" }), "LANG=C");
    await user.clear(screen.getByRole("spinbutton", { name: "Timeout seconds" }));
    await user.type(screen.getByRole("spinbutton", { name: "Timeout seconds" }), "27");
    await user.type(screen.getByRole("textbox", { name: "Remote stdout path" }), "/tmp/out.txt");
    expect(screen.getByRole("switch", { name: /Run in background/u })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Environment overrides" })).toHaveValue("LANG=C");
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
    await user.click(screen.getByRole("switch", { name: /Use current token/u }));
    await user.type(screen.getByRole("spinbutton", { name: "Parent process ID" }), "1234");
    await user.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
    expect(onPrepare).toHaveBeenCalledWith(expect.objectContaining({
      useToken: true,
      parentPid: 1234,
    }));
  });

  it("accepts a quoted Windows executable path without sending quote characters to Sliver", async () => {
    const user = userEvent.setup();
    const { onPrepare } = renderCompact({ ...linuxTarget, os: "windows", arch: "amd64" });
    const executable = screen.getByRole("textbox", { name: "Executable path" });
    await user.clear(executable);
    await user.type(executable, '"C:\\Windows\\System32\\tasklist.exe"');
    await user.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
    expect(onPrepare).toHaveBeenCalledWith(expect.objectContaining({
      path: "C:\\Windows\\System32\\tasklist.exe",
      args: [],
      captureOutput: true,
      background: false,
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
