import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const shellMocks = vi.hoisted(() => ({
  open: vi.fn(),
  focus: vi.fn(),
  getSelection: vi.fn(() => "selected output"),
  paste: vi.fn(),
  onClipboardPaste: undefined as ((text: string) => void | Promise<void>) | undefined,
}));

vi.mock("../components/GhosttyTerminal", async () => {
  const React = await import("react");
  return {
    GhosttyTerminal: React.forwardRef(function MockGhosttyTerminal(
      props: {
        ariaLabel?: string;
        disableInput?: boolean;
        enableClipboard?: boolean;
        pipedWindowsInput?: boolean;
        onClipboardPaste?: (text: string) => void | Promise<void>;
        onError?: (error: Error) => void;
        onReady?: () => void;
        transport: {
          subscribe: (subscription: {
            onOutput: (bytes: Uint8Array) => void;
            onClose: (reason?: string) => void;
          }) => () => void;
        };
      },
      ref: React.ForwardedRef<unknown>,
    ) {
      const hostRef = React.useRef<HTMLDivElement>(null);
      const outputRef = React.useRef("");
      shellMocks.onClipboardPaste = props.onClipboardPaste;
      React.useImperativeHandle(ref, () => ({
        focus: shellMocks.focus,
        getSelection: shellMocks.getSelection,
        paste: shellMocks.paste,
      }));
      React.useEffect(() => props.onReady?.(), [props.onReady]);
      React.useEffect(() => props.transport.subscribe({
        onOutput: (bytes) => {
          outputRef.current += new TextDecoder().decode(bytes);
          hostRef.current?.setAttribute("data-terminal-output", outputRef.current);
        },
        onClose: (reason) => hostRef.current?.setAttribute("data-terminal-close", reason ?? "closed"),
      }), [props.transport]);
      return (
        <div
          ref={hostRef}
          aria-label={props.ariaLabel}
          data-terminal-clipboard-enabled={String(Boolean(props.enableClipboard))}
          data-terminal-input-disabled={String(Boolean(props.disableInput))}
          data-terminal-piped-windows-input={String(Boolean(props.pipedWindowsInput))}
          data-terminal-output=""
          role="textbox"
        >
          Terminal bytes stay outside React state
          <button
            aria-label="Inject terminal initialization failure"
            onClick={() => props.onError?.(new Error("Terminal initialization failed safely"))}
            type="button"
          />
        </div>
      );
    }),
  };
});

vi.mock("../components/session-shell-transport", () => ({
  SessionShellTransport: { open: shellMocks.open },
}));

import type { SliverDesktopAPI } from "../../../shared/contracts";
import type { SessionSummary } from "../../../shared/target-contracts";
import type {
  PrepareSessionShellInput,
  SessionShellResource,
  SessionShellResourceList,
  SessionShellPlan,
  SessionShellResourceAction,
} from "../../../shared/stream-contracts";
import {
  SessionTerminalPanel,
  clearSessionTerminalRuntimeCacheForTests,
  defaultSessionShellInput,
  inspectPaste,
  requiresPasteConfirmation,
  type SessionTerminalRoute,
} from "./SessionTerminalPanel";
import type {
  SessionShellTransport,
  SessionShellTransportSnapshot,
} from "../components/session-shell-transport";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(Element.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
});

beforeEach(() => {
  clearSessionTerminalRuntimeCacheForTests();
  setViewport(true);
  shellMocks.open.mockReset();
  shellMocks.focus.mockReset();
  shellMocks.getSelection.mockReset().mockReturnValue("selected output");
  shellMocks.paste.mockReset();
  shellMocks.onClipboardPaste = undefined;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  Reflect.deleteProperty(Element.prototype, "setPointerCapture");
  Reflect.deleteProperty(Element.prototype, "releasePointerCapture");
});

const session: SessionSummary = {
  mode: "session",
  id: "session-1",
  name: "payments",
  hostname: "prod-linux",
  hostId: "host-1",
  username: "alice",
  os: "linux",
  arch: "amd64",
  transport: "mtls",
  remoteAddress: "10.0.0.8:4444",
  activeC2: "mtls://10.0.0.8:4444",
  executable: "/tmp/agent",
  version: "1.7.6",
  locale: "en-US",
  integrity: "High",
  burned: false,
  pid: 4001,
  liveness: "active",
};

const route: SessionTerminalRoute = {
  sessionId: session.id,
  backendEpoch: 7,
  connectionIncarnation: 4,
  targetFingerprint: "a".repeat(64),
};

const resourceId = "r".repeat(43);
const attachmentToken = "t".repeat(43);

describe("SessionTerminalPanel", () => {
  it("renders explicit loading and empty states after verifying the runtime", async () => {
    const runtime = deferred<unknown>();
    const shells = deferred<unknown>();
    const api = installAPI({
      getTerminalRuntime: () => runtime.promise,
      listSessionShells: () => shells.promise,
    });

    render(<SessionTerminalPanel route={route} session={session} />);
    expect(screen.getByText("Loading terminal runtime")).toBeInTheDocument();

    runtime.resolve(runtimeResult());
    await waitFor(() => expect(api.listSessionShells).toHaveBeenCalledWith({}));
    shells.resolve({ ok: true, value: inventory([]) });

    expect(await screen.findByText("No managed shells")).toBeInTheDocument();
    expect(screen.getByText("No shell selected")).toBeInTheDocument();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("coalesces StrictMode and remount runtime loads without a false admission error", async () => {
    const runtime = deferred<unknown>();
    const api = installAPI({
      getTerminalRuntime: () => runtime.promise,
      listSessionShells: async () => ({ ok: true, value: inventory([]) }),
    });
    const first = render(
      <StrictMode>
        <SessionTerminalPanel route={route} session={session} />
      </StrictMode>,
    );

    await waitFor(() => expect(api.getTerminalRuntime).toHaveBeenCalledOnce());
    runtime.resolve(runtimeResult());
    expect(await screen.findByText("No managed shells")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    first.unmount();
    render(
      <StrictMode>
        <SessionTerminalPanel route={route} session={session} />
      </StrictMode>,
    );
    expect(await screen.findByText("No managed shells")).toBeInTheDocument();
    expect(api.getTerminalRuntime).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps runtime and inventory failures recoverable and metadata-only", async () => {
    const runtimeLoader = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "Pinned runtime verification failed" })
      .mockResolvedValue(runtimeResult());
    const api = installAPI({
      getTerminalRuntime: runtimeLoader,
    });
    const first = render(<SessionTerminalPanel route={route} session={session} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Pinned runtime verification failed");
    expect(screen.getByText("No shell selected")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    first.unmount();
    render(<SessionTerminalPanel route={route} session={session} />);
    expect(await screen.findByText("No managed shells")).toBeInTheDocument();
    expect(api.getTerminalRuntime).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("starts a Linux shell with an omitted path and a requested-unconfirmed PTY", async () => {
    const transport = fakeTransport();
    shellMocks.open.mockResolvedValue(transport.api);
    const managed = resource();
    const api = installAPI({
      listSessionShells: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: inventory([]) })
        .mockResolvedValue({ ok: true, value: inventory([managed]) }),
      prepareSessionShell: async () => ({ ok: true, value: plan() }),
    });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("No managed shells");

    await user.click(screen.getAllByRole("button", { name: "New shell" })[0]!);
    await waitFor(() => expect(api.prepareSessionShell).toHaveBeenCalledWith({
      requestPty: true,
      rows: 24,
      columns: 80,
    }));
    expect(api.prepareSessionShell.mock.calls[0]?.[0]).not.toHaveProperty("path");
    await waitFor(() => expect(shellMocks.open).toHaveBeenCalledWith(expect.objectContaining({
      attachmentToken,
      expectedResourceId: resourceId,
      canResize: true,
      isCurrent: expect.any(Function),
    })));
    expect(await screen.findByRole("textbox", { name: "Interactive shell for payments" })).toBeInTheDocument();
    expect(screen.getAllByText(/PTY requested · unconfirmed/u)).not.toHaveLength(0);
  });

  it("closes the exact attached transport when terminal initialization fails", async () => {
    const transport = fakeTransport();
    shellMocks.open.mockResolvedValue(transport.api);
    installAPI({
      listSessionShells: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: inventory([]) })
        .mockResolvedValue({ ok: true, value: inventory([resource()]) }),
      prepareSessionShell: async () => ({ ok: true, value: plan() }),
    });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("No managed shells");
    await user.click(screen.getAllByRole("button", { name: "New shell" })[0]!);
    await screen.findByRole("textbox", { name: "Interactive shell for payments" });

    await user.click(screen.getByRole("button", { name: "Inject terminal initialization failure" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Terminal initialization failed safely");
    expect(transport.close).toHaveBeenCalledOnce();
    expect(transport.detach).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Interactive shell for payments" })).not.toBeInTheDocument();
  });

  it("uses the interactive terminal for non-PTY Windows shells", async () => {
    const windowsSession = { ...session, os: "windows", arch: "amd64" };
    const transport = fakeTransport();
    shellMocks.open.mockResolvedValue(transport.api);
    const api = installAPI({
      listSessionShells: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: inventory([]) })
        .mockResolvedValue({ ok: true, value: inventory([resource({ pty: "disabled", canResize: false })]) }),
      prepareSessionShell: async () => ({ ok: true, value: plan({ pty: "disabled", canResize: false }) }),
    });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={windowsSession} />);
    await screen.findByText("No managed shells");

    await user.click(screen.getAllByRole("button", { name: "New shell" })[0]!);
    await waitFor(() => expect(api.prepareSessionShell).toHaveBeenCalledWith({ requestPty: false }));
    expect(screen.getByText(/Non-PTY · Windows resize unavailable/u)).toBeInTheDocument();
    const terminal = screen.getByRole("textbox", { name: "Interactive shell for payments" });
    expect(terminal).toHaveAttribute("data-terminal-input-disabled", "false");
    expect(terminal).toHaveAttribute("data-terminal-piped-windows-input", "true");
    expect(screen.queryByRole("textbox", { name: "Windows command" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paste" })).toBeInTheDocument();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("auto-attaches one detached shell activation, focuses it, and routes detach through the managed action API", async () => {
    const detached = resource({ state: "detached" });
    const transport = fakeTransport();
    shellMocks.open.mockResolvedValue(transport.api);
    const api = installAPI({
      listSessionShells: async () => ({ ok: true, value: inventory([detached]) }),
      actOnSessionShell: async (_resourceId, action) => (
        action === "attach"
          ? { ok: true, value: { action, resourceId, resource: detached, attachment: { attachmentToken, expiresAt: new Date(Date.now() + 5_000).toISOString() } } }
          : { ok: true, value: { action, resourceId, resource: detached } }
      ),
    });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("Shell 1");
    expect(screen.getByText("No shell selected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach" })).not.toBeInTheDocument();
    expect(api.actOnSessionShell).not.toHaveBeenCalled();

    await user.click(screen.getByText("Shell 1"));
    await waitFor(() => expect(api.actOnSessionShell).toHaveBeenCalledTimes(1));
    expect(api.actOnSessionShell).toHaveBeenCalledWith({ resourceId, action: "attach" });
    expect(await screen.findByRole("textbox", { name: "Interactive shell for payments" })).toBeInTheDocument();
    expect(shellMocks.focus).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Focus" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stats" })).toBeInTheDocument();
    expect(screen.queryByText("Input queued")).not.toBeInTheDocument();
    act(() => transport.emit({
      ...attachedSnapshot(),
      pressure: "high",
      queuedInputBytes: 1_024,
      queuedOutputBytes: 2_048,
      bytesFromRemote: "1234",
      bytesToRemote: "5678",
    }));
    expect(await screen.findByText("Backpressure")).toBeInTheDocument();

    const statsButton = screen.getByRole("button", { name: "Stats" });
    await user.click(statsButton);
    const statistics = await screen.findByRole("dialog", { name: "Shell statistics" });
    expect(statistics).toBeInTheDocument();
    expect(screen.getByText("Input queued").closest("div")).toHaveTextContent("1.0 KiB");
    expect(screen.getByText("Output queued").closest("div")).toHaveTextContent("2.0 KiB");
    expect(screen.getByText("Bytes in").closest("div")).toHaveTextContent("1,234");
    expect(screen.getByText("Bytes out").closest("div")).toHaveTextContent("5,678");
    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    await user.click(closeButtons.at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Shell statistics" })).not.toBeInTheDocument());
    await waitFor(() => expect(statsButton).toHaveFocus());
    expect(screen.getByRole("textbox", { name: "Interactive shell for payments" })).toBeInTheDocument();

    vi.mocked(api.actOnSessionShell).mockClear();
    shellMocks.focus.mockClear();
    await user.click(screen.getByText("Shell 1"));
    expect(api.actOnSessionShell).not.toHaveBeenCalled();
    expect(transport.detach).not.toHaveBeenCalled();
    expect(shellMocks.focus).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(api.actOnSessionShell).toHaveBeenCalledWith({
      resourceId,
      action: "detach",
    }));
    expect(transport.detach).toHaveBeenCalledOnce();
  });

  it("keeps distinct shell terminals mounted and processing output across A to B to A selection", async () => {
    const firstResourceId = "a".repeat(43);
    const secondResourceId = "b".repeat(43);
    const firstToken = "c".repeat(43);
    const secondToken = "d".repeat(43);
    const first = resource({
      resourceId: firstResourceId,
      state: "detached",
      createdAt: "2026-08-10T01:00:00.000Z",
    });
    const second = resource({
      resourceId: secondResourceId,
      state: "detached",
      createdAt: "2026-08-10T01:01:00.000Z",
    });
    const firstTransport = fakeTransport();
    const secondTransport = fakeTransport();
    shellMocks.open
      .mockResolvedValueOnce(firstTransport.api)
      .mockResolvedValueOnce(secondTransport.api);
    const api = installAPI({
      listSessionShells: async () => ({ ok: true, value: inventory([first, second]) }),
      actOnSessionShell: async (requestedResourceId, action) => {
        const selected = requestedResourceId === firstResourceId ? first : second;
        return {
          ok: true,
          value: {
            action,
            resourceId: requestedResourceId,
            resource: selected,
            attachment: {
              attachmentToken: requestedResourceId === firstResourceId ? firstToken : secondToken,
              expiresAt: new Date(Date.now() + 5_000).toISOString(),
            },
          },
        };
      },
    });
    const user = userEvent.setup();
    const { container } = render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("Shell 1");

    await user.click(screen.getByText("Shell 1"));
    await screen.findByRole("textbox", { name: "Interactive shell for payments" });
    const firstWrapper = container.querySelector<HTMLElement>(
      `[data-shell-terminal-resource-id="${firstResourceId}"]`,
    );
    const firstTerminal = firstWrapper?.querySelector<HTMLElement>("[role=textbox]");
    expect(firstWrapper).not.toBeNull();
    act(() => firstTransport.emitOutput("first-visible\n"));
    expect(firstTerminal).toHaveAttribute("data-terminal-output", "first-visible\n");

    await user.click(screen.getByText("Shell 2"));
    await waitFor(() => expect(shellMocks.open).toHaveBeenCalledTimes(2));
    const secondWrapper = container.querySelector<HTMLElement>(
      `[data-shell-terminal-resource-id="${secondResourceId}"]`,
    );
    expect(secondWrapper).not.toBeNull();
    expect(firstWrapper).toHaveAttribute("aria-hidden", "true");
    expect(firstTransport.detach).not.toHaveBeenCalled();
    expect(api.actOnSessionShell).not.toHaveBeenCalledWith({ resourceId: firstResourceId, action: "detach" });

    act(() => firstTransport.emitOutput("first-hidden\n"));
    expect(firstTerminal).toHaveAttribute(
      "data-terminal-output",
      "first-visible\nfirst-hidden\n",
    );

    await user.click(screen.getByText("Shell 1"));
    expect(container.querySelector(`[data-shell-terminal-resource-id="${firstResourceId}"]`)).toBe(firstWrapper);
    expect(firstWrapper).not.toHaveAttribute("aria-hidden", "true");
    expect(secondWrapper).toHaveAttribute("aria-hidden", "true");
    expect(shellMocks.open).toHaveBeenCalledTimes(2);
    expect(firstTransport.detach).not.toHaveBeenCalled();
    expect(secondTransport.detach).not.toHaveBeenCalled();
    expect(firstTerminal).toHaveAttribute(
      "data-terminal-output",
      "first-visible\nfirst-hidden\n",
    );
  });

  it("keeps metadata statistics available for a selected detached shell", async () => {
    const base = resource();
    const detached = resource({
      state: "detached",
      metrics: {
        ...base.metrics,
        queuedInputBytes: 512,
        queuedOutputBytes: 1_024,
        bytesToRenderer: "42",
        bytesFromRenderer: "17",
      },
    });
    installAPI({
      listSessionShells: async () => ({ ok: true, value: inventory([detached]) }),
      actOnSessionShell: async () => ({ ok: false, error: "Attachment unavailable" }),
    });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("Shell 1");

    await user.click(screen.getByText("Shell 1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Attachment unavailable");
    expect(screen.queryByText("Input queued")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stats" }));

    const statistics = await screen.findByRole("dialog", { name: "Shell statistics" });
    expect(statistics).toHaveTextContent("512 B");
    expect(statistics).toHaveTextContent("1.0 KiB");
    expect(statistics).toHaveTextContent("42");
    expect(statistics).toHaveTextContent("17");
  });

  it("refreshes and auto-attaches a main-transferred shell without letting an older inventory win", async () => {
    const staleInventory = deferred<unknown>();
    const transferredInventory = deferred<unknown>();
    const detached = resource({ state: "detached" });
    const transport = fakeTransport();
    let notifyShellsChanged: ((preferredResourceId?: string) => void) | undefined;
    shellMocks.open.mockResolvedValue(transport.api);
    const listSessionShells = vi.fn()
      .mockReturnValueOnce(staleInventory.promise)
      .mockReturnValueOnce(transferredInventory.promise)
      .mockResolvedValue({ ok: true, value: inventory([detached]) });
    const api = installAPI({
      listSessionShells,
      onSessionShellsChanged: (listener) => {
        notifyShellsChanged = listener;
        return vi.fn();
      },
      actOnSessionShell: async (_resourceId, action) => ({
        ok: true,
        value: {
          action,
          resourceId,
          resource: detached,
          attachment: {
            attachmentToken,
            expiresAt: new Date(Date.now() + 5_000).toISOString(),
          },
        },
      }),
    });

    render(<SessionTerminalPanel route={route} session={session} />);
    await waitFor(() => expect(listSessionShells).toHaveBeenCalledOnce());
    act(() => notifyShellsChanged?.(resourceId));
    await waitFor(() => expect(listSessionShells).toHaveBeenCalledTimes(2));
    transferredInventory.resolve({ ok: true, value: inventory([detached]) });
    staleInventory.resolve({ ok: true, value: inventory([]) });

    expect(await screen.findByRole("textbox", { name: "Interactive shell for payments" })).toBeInTheDocument();
    expect(api.actOnSessionShell).toHaveBeenCalledWith({ resourceId, action: "attach" });
    await act(async () => undefined);
    expect(screen.getByText("Shell 1")).toBeInTheDocument();
    expect(screen.queryByText("No managed shells")).not.toBeInTheDocument();
  });

  it("coalesces rapid selections, consumes the stale ticket, and adopts only the latest shell", async () => {
    const firstResourceId = "a".repeat(43);
    const secondResourceId = "b".repeat(43);
    const firstToken = "c".repeat(43);
    const secondToken = "d".repeat(43);
    const first = resource({
      resourceId: firstResourceId,
      state: "detached",
      createdAt: "2026-08-10T01:00:00.000Z",
    });
    const second = resource({
      resourceId: secondResourceId,
      state: "detached",
      createdAt: "2026-08-10T01:01:00.000Z",
    });
    const firstTicket = deferred<unknown>();
    const firstOpen = deferred<SessionShellTransport>();
    const firstTransport = fakeTransport();
    const secondTransport = fakeTransport();
    shellMocks.open
      .mockReturnValueOnce(firstOpen.promise)
      .mockResolvedValueOnce(secondTransport.api);
    const api = installAPI({
      listSessionShells: async () => ({ ok: true, value: inventory([first, second]) }),
      actOnSessionShell: async (requestedResourceId, action) => {
        if (action === "detach") {
          return { ok: true, value: { action, resourceId: requestedResourceId, resource: first } };
        }
        if (requestedResourceId === firstResourceId) return firstTicket.promise;
        return {
          ok: true,
          value: {
            action,
            resourceId: secondResourceId,
            resource: second,
            attachment: {
              attachmentToken: secondToken,
              expiresAt: new Date(Date.now() + 5_000).toISOString(),
            },
          },
        };
      },
    });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("Shell 1");

    await user.click(screen.getByText("Shell 1"));
    await waitFor(() => expect(api.actOnSessionShell).toHaveBeenCalledWith({
      resourceId: firstResourceId,
      action: "attach",
    }));
    await user.click(screen.getByText("Shell 2"));
    firstTicket.resolve({
      ok: true,
      value: {
        action: "attach",
        resourceId: firstResourceId,
        resource: first,
        attachment: {
          attachmentToken: firstToken,
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
        },
      },
    });
    await waitFor(() => expect(shellMocks.open).toHaveBeenCalledWith(expect.objectContaining({
      attachmentToken: firstToken,
      expectedResourceId: firstResourceId,
    })));
    expect(shellMocks.open).toHaveBeenCalledTimes(1);

    firstOpen.resolve(firstTransport.api);
    await waitFor(() => expect(firstTransport.detach).toHaveBeenCalledOnce());
    await waitFor(() => expect(shellMocks.open).toHaveBeenCalledTimes(2));
    expect(shellMocks.open).toHaveBeenLastCalledWith(expect.objectContaining({
      attachmentToken: secondToken,
      expectedResourceId: secondResourceId,
    }));
    expect(await screen.findByRole("textbox", { name: "Interactive shell for payments" })).toBeInTheDocument();
    expect(screen.getByText("Shell 2").closest("[role=row]")).toHaveAttribute("aria-selected", "true");

    const attachCalls = api.actOnSessionShell.mock.calls.filter(([input]) => input.action === "attach");
    expect(attachCalls).toEqual([
      [{ resourceId: firstResourceId, action: "attach" }],
      [{ resourceId: secondResourceId, action: "attach" }],
    ]);
  });

  it("preserves the active terminal when it is reselected during another shell attachment", async () => {
    const firstResourceId = "a".repeat(43);
    const secondResourceId = "b".repeat(43);
    const firstToken = "c".repeat(43);
    const secondToken = "d".repeat(43);
    const first = resource({
      resourceId: firstResourceId,
      state: "detached",
      createdAt: "2026-08-10T01:00:00.000Z",
    });
    const second = resource({
      resourceId: secondResourceId,
      state: "detached",
      createdAt: "2026-08-10T01:01:00.000Z",
    });
    const secondTicket = deferred<unknown>();
    const firstTransport = fakeTransport();
    const replacementTransport = fakeTransport();
    shellMocks.open
      .mockResolvedValueOnce(firstTransport.api)
      .mockResolvedValueOnce(replacementTransport.api);
    const api = installAPI({
      listSessionShells: async () => ({ ok: true, value: inventory([first, second]) }),
      actOnSessionShell: async (requestedResourceId, action) => {
        if (action === "attach" && requestedResourceId === secondResourceId) return secondTicket.promise;
        if (action === "detach") {
          return { ok: true, value: { action, resourceId: requestedResourceId, resource: second } };
        }
        const selected = requestedResourceId === firstResourceId ? first : second;
        return {
          ok: true,
          value: {
            action,
            resourceId: requestedResourceId,
            resource: selected,
            attachment: {
              attachmentToken: requestedResourceId === firstResourceId ? firstToken : secondToken,
              expiresAt: new Date(Date.now() + 5_000).toISOString(),
            },
          },
        };
      },
    });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("Shell 1");

    await user.click(screen.getByText("Shell 1"));
    await screen.findByRole("textbox", { name: "Interactive shell for payments" });
    vi.mocked(api.actOnSessionShell).mockClear();

    await user.click(screen.getByText("Shell 2"));
    await waitFor(() => expect(api.actOnSessionShell).toHaveBeenCalledWith({
      resourceId: secondResourceId,
      action: "attach",
    }));
    await user.click(screen.getByText("Shell 1"));
    secondTicket.resolve({
      ok: true,
      value: {
        action: "attach",
        resourceId: secondResourceId,
        resource: second,
        attachment: {
          attachmentToken: secondToken,
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
        },
      },
    });

    await waitFor(() => expect(shellMocks.open).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(replacementTransport.detach).toHaveBeenCalledOnce());
    expect(firstTransport.detach).not.toHaveBeenCalled();
    expect(shellMocks.open).toHaveBeenLastCalledWith(expect.objectContaining({
      attachmentToken: secondToken,
      expectedResourceId: secondResourceId,
    }));
    const attachCalls = api.actOnSessionShell.mock.calls.filter(([input]) => input.action === "attach");
    expect(attachCalls).toEqual([[{ resourceId: secondResourceId, action: "attach" }]]);
    expect(api.actOnSessionShell).toHaveBeenCalledWith({ resourceId: secondResourceId, action: "detach" });
    expect(screen.getByText("Shell 1").closest("[role=row]")).toHaveAttribute("aria-selected", "true");
  });

  it.each([
    {
      action: "close" as const,
      trigger: "Close",
      confirm: "Close shell",
      heading: "Close this managed shell?",
      copy: "does not confirm remote process termination",
    },
    {
      action: "kill" as const,
      trigger: "Kill",
      confirm: "Kill process",
      heading: "Kill this shell process?",
      copy: "exit outcome may be unknown",
    },
  ])("requires an explicit confirmation before $action", async ({ action, trigger, confirm, heading, copy }) => {
    const detached = resource({ state: "detached" });
    const transport = fakeTransport();
    shellMocks.open.mockResolvedValue(transport.api);
    const listSessionShells = vi.fn().mockResolvedValue({ ok: true, value: inventory([detached]) });
    const api = installAPI({
      listSessionShells,
      actOnSessionShell: async (_resourceId, requestedAction) => ({
        ok: true,
        value: requestedAction === "attach"
          ? {
              action: requestedAction,
              resourceId,
              resource: detached,
              attachment: { attachmentToken, expiresAt: new Date(Date.now() + 5_000).toISOString() },
            }
          : { action: requestedAction, resourceId },
      }),
    });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("Shell 1");
    await user.click(screen.getByText("Shell 1"));
    await screen.findByRole("textbox", { name: "Interactive shell for payments" });

    await user.click(screen.getByRole("button", { name: trigger }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(heading);
    expect(dialog).toHaveTextContent(copy);
    expect(api.actOnSessionShell).not.toHaveBeenCalledWith({ resourceId, action });
    await user.click(screen.getByRole("button", { name: confirm }));
    await waitFor(() => expect(api.actOnSessionShell).toHaveBeenCalledWith({ resourceId, action }));
  });

  it("requires explicit review for multiline toolbar paste and never renders the clipboard payload", async () => {
    const secretClipboardText = "echo hidden-secret\nuname -a";
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: vi.fn().mockResolvedValue(secretClipboardText),
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    shellMocks.open.mockResolvedValue(fakeTransport().api);
    installAPI({
      listSessionShells: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: inventory([]) })
        .mockResolvedValue({ ok: true, value: inventory([resource()]) }),
      prepareSessionShell: async () => ({ ok: true, value: plan() }),
    });
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("No managed shells");
    await user.click(screen.getAllByRole("button", { name: "New shell" })[0]!);
    const terminal = await screen.findByRole("textbox", { name: "Interactive shell for payments" });
    expect(terminal).toHaveAttribute("data-terminal-clipboard-enabled", "true");
    expect(shellMocks.onClipboardPaste).toBeTypeOf("function");

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("selected output");
    await user.click(screen.getByRole("button", { name: "Paste" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("2 lines");
    expect(screen.queryByText(secretClipboardText)).not.toBeInTheDocument();
    expect(shellMocks.paste).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Paste anyway" }));
    expect(shellMocks.paste).toHaveBeenCalledWith(secretClipboardText);
    expect(shellMocks.focus).toHaveBeenCalled();
  });

  it("routes delegated terminal Paste through the same metadata-only review", async () => {
    const secretClipboardText = "echo context-secret\nuname -a";
    const user = userEvent.setup();
    shellMocks.open.mockResolvedValue(fakeTransport().api);
    installAPI({
      listSessionShells: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: inventory([]) })
        .mockResolvedValue({ ok: true, value: inventory([resource()]) }),
      prepareSessionShell: async () => ({ ok: true, value: plan() }),
    });
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("No managed shells");
    await user.click(screen.getAllByRole("button", { name: "New shell" })[0]!);
    const terminal = await screen.findByRole("textbox", { name: "Interactive shell for payments" });
    expect(terminal).toHaveAttribute("data-terminal-clipboard-enabled", "true");
    expect(shellMocks.onClipboardPaste).toBeTypeOf("function");
    shellMocks.focus.mockClear();

    act(() => {
      shellMocks.onClipboardPaste?.(secretClipboardText);
    });

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("2 lines");
    expect(screen.queryByText(secretClipboardText)).not.toBeInTheDocument();
    expect(shellMocks.paste).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Paste anyway" }));
    expect(shellMocks.paste).toHaveBeenCalledExactlyOnceWith(secretClipboardText);
    expect(shellMocks.focus).toHaveBeenCalledOnce();
  });

  it("does not redirect a reviewed paste when another managed shell becomes selected", async () => {
    const firstResourceId = "a".repeat(43);
    const secondResourceId = "b".repeat(43);
    const first = resource({ resourceId: firstResourceId, state: "detached" });
    const second = resource({
      resourceId: secondResourceId,
      state: "detached",
      createdAt: "2026-08-10T01:01:00.000Z",
    });
    let notifyShellsChanged: ((preferredResourceId?: string) => void) | undefined;
    shellMocks.open
      .mockResolvedValueOnce(fakeTransport().api)
      .mockResolvedValueOnce(fakeTransport().api);
    const api = installAPI({
      listSessionShells: async () => ({ ok: true, value: inventory([first, second]) }),
      onSessionShellsChanged: (listener) => {
        notifyShellsChanged = listener;
        return vi.fn();
      },
      actOnSessionShell: async (requestedResourceId, action) => ({
        ok: true,
        value: {
          action,
          resourceId: requestedResourceId,
          resource: requestedResourceId === firstResourceId ? first : second,
          attachment: {
            attachmentToken: requestedResourceId === firstResourceId
              ? "c".repeat(43)
              : "d".repeat(43),
            expiresAt: new Date(Date.now() + 5_000).toISOString(),
          },
        },
      }),
    });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("Shell 1");
    await user.click(screen.getByText("Shell 1"));
    await screen.findByRole("textbox", { name: "Interactive shell for payments" });

    act(() => {
      shellMocks.onClipboardPaste?.("echo first\necho second");
    });
    await screen.findByRole("alertdialog");
    act(() => notifyShellsChanged?.(secondResourceId));
    await waitFor(() => expect(api.actOnSessionShell).toHaveBeenCalledWith({
      resourceId: secondResourceId,
      action: "attach",
    }));
    await waitFor(() => {
      expect(screen.getByText("Shell 2").closest("[role=row]"))
        .toHaveAttribute("aria-selected", "true");
    });

    await user.click(screen.getByRole("button", { name: "Paste anyway" }));
    expect(shellMocks.paste).not.toHaveBeenCalled();
  });

  it("quarantines stale prepare callbacks and detaches on route replacement", async () => {
    const prepared = deferred<unknown>();
    const firstTransport = fakeTransport();
    shellMocks.open.mockResolvedValue(firstTransport.api);
    const api = installAPI({
      listSessionShells: async () => ({ ok: true, value: inventory([]) }),
      prepareSessionShell: () => prepared.promise,
    });
    const user = userEvent.setup();
    const { rerender } = render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("No managed shells");
    await user.click(screen.getAllByRole("button", { name: "New shell" })[0]!);

    const replacementRoute = { ...route, connectionIncarnation: route.connectionIncarnation + 1 };
    rerender(<SessionTerminalPanel route={replacementRoute} session={session} />);
    prepared.resolve({ ok: true, value: plan() });
    await waitFor(() => expect(api.listSessionShells).toHaveBeenCalledTimes(2));
    expect(api.getTerminalRuntime).toHaveBeenCalledOnce();
    expect(shellMocks.open).not.toHaveBeenCalled();

    // Attach on the replacement route, then prove the next reconnect cleanup
    // explicitly detaches the main-owned resource before accepting new state.
    api.prepareSessionShell.mockResolvedValue({ ok: true, value: plan() });
    await screen.findByText("No managed shells");
    await user.click(screen.getAllByRole("button", { name: "New shell" })[0]!);
    await waitFor(() => expect(shellMocks.open).toHaveBeenCalledOnce());
    const thirdRoute = { ...replacementRoute, connectionIncarnation: replacementRoute.connectionIncarnation + 1 };
    rerender(<SessionTerminalPanel route={thirdRoute} session={session} />);
    expect(firstTransport.detach).toHaveBeenCalledOnce();
  });

  it("attaches a dedicated window preferred resource exactly once", async () => {
    const detached = resource({ state: "detached" });
    const transport = fakeTransport();
    shellMocks.open.mockResolvedValue(transport.api);
    const api = installAPI({
      listSessionShells: async () => ({ ok: true, value: inventory([detached]) }),
      actOnSessionShell: async (_resourceId, action) => ({
        ok: true,
        value: {
          action,
          resourceId,
          resource: detached,
          attachment: { attachmentToken, expiresAt: new Date(Date.now() + 5_000).toISOString() },
        },
      }),
    });
    const onPopOut = vi.fn().mockResolvedValue(undefined);
    const { container, rerender } = render(
      <SessionTerminalPanel
        onPopOut={onPopOut}
        preferredResourceId={resourceId}
        presentation="dedicated"
        route={route}
        session={session}
      />,
    );

    expect(await screen.findByRole("textbox", { name: "Interactive shell for payments" })).toBeInTheDocument();
    expect(api.actOnSessionShell).toHaveBeenCalledTimes(1);
    expect(api.actOnSessionShell).toHaveBeenCalledWith({ resourceId, action: "attach" });
    expect(container.querySelector("[data-presentation=dedicated]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Pop out managed shells" })).not.toBeInTheDocument();

    rerender(
      <SessionTerminalPanel
        onPopOut={onPopOut}
        preferredResourceId={resourceId}
        presentation="dedicated"
        route={route}
        session={session}
      />,
    );
    await Promise.resolve();
    expect(api.actOnSessionShell).toHaveBeenCalledTimes(1);
  });

  it("offers a tooltip-labelled asynchronous pop-out action only in embedded presentation", async () => {
    const popOutRequest = deferred<void>();
    const onPopOut = vi.fn(() => popOutRequest.promise);
    installAPI({ listSessionShells: async () => ({ ok: true, value: inventory([]) }) });
    const user = userEvent.setup();
    render(<SessionTerminalPanel onPopOut={onPopOut} route={route} session={session} />);
    await screen.findByText("No managed shells");

    const trigger = screen.getByRole("button", { name: "Pop out managed shells" });
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Pop out managed shells");
    await user.click(trigger);
    await user.click(trigger);
    expect(onPopOut).toHaveBeenCalledOnce();
    expect(onPopOut).toHaveBeenCalledWith(undefined);

    popOutRequest.resolve();
    await waitFor(() => expect(trigger).not.toHaveAttribute("data-pending"));
  });

  it("keeps the narrow shell sheet open until selection-driven attachment succeeds", async () => {
    setViewport(false);
    const detached = resource({ state: "detached" });
    const opened = deferred<SessionShellTransport>();
    const transport = fakeTransport();
    shellMocks.open.mockReturnValue(opened.promise);
    installAPI({
      listSessionShells: async () => ({ ok: true, value: inventory([detached]) }),
      actOnSessionShell: async (_resourceId, action) => ({
        ok: true,
        value: {
          action,
          resourceId,
          resource: detached,
          attachment: { attachmentToken, expiresAt: new Date(Date.now() + 5_000).toISOString() },
        },
      }),
    });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("No shell selected");

    await user.click(screen.getByRole("button", { name: "Shells" }));
    expect(await screen.findByRole("dialog", { name: "Managed Shells" })).toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    await user.click(screen.getByText("Shell 1"));
    await waitFor(() => expect(shellMocks.open).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog", { name: "Managed Shells" })).toBeInTheDocument();

    opened.resolve(transport.api);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Managed Shells" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("textbox", { name: "Interactive shell for payments" })).toBeInTheDocument();
  });
});

describe("session terminal safety helpers", () => {
  it("derives platform-gated defaults and metadata-only paste review", () => {
    expect(defaultSessionShellInput("darwin")).toEqual({ requestPty: true, rows: 24, columns: 80 });
    expect(defaultSessionShellInput("windows")).toEqual({ requestPty: false });
    const review = inspectPaste("one\ntwo\t");
    expect(review).toEqual({ bytes: 8, lines: 2, controlCharacters: 2 });
    expect(requiresPasteConfirmation(review)).toBe(true);
  });
});

function installAPI(overrides: {
  getTerminalRuntime?: () => Promise<unknown> | unknown;
  listSessionShells?: () => Promise<unknown> | unknown;
  prepareSessionShell?: (input: PrepareSessionShellInput) => Promise<unknown> | unknown;
  actOnSessionShell?: (
    resourceId: string,
    action: SessionShellResourceAction,
  ) => Promise<unknown> | unknown;
  onSessionShellsChanged?: (listener: (preferredResourceId?: string) => void) => () => void;
} = {}) {
  const getTerminalRuntime = vi.fn(async () => overrides.getTerminalRuntime?.() ?? runtimeResult());
  const listSessionShells = vi.fn(async () => overrides.listSessionShells?.() ?? ({ ok: true, value: inventory([]) }));
  const prepareSessionShell = vi.fn(async (input: PrepareSessionShellInput) =>
    overrides.prepareSessionShell?.(input) ?? ({ ok: false, error: "Not configured" }));
  const actOnSessionShell = vi.fn(async (input: { resourceId: string; action: SessionShellResourceAction }) =>
    overrides.actOnSessionShell?.(input.resourceId, input.action) ?? ({ ok: false, error: "Not configured" }));
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: {
      getTerminalRuntime,
      listSessionShells,
      prepareSessionShell,
      actOnSessionShell,
      onSessionShellsChanged: overrides.onSessionShellsChanged ?? vi.fn(() => vi.fn()),
    } as unknown as SliverDesktopAPI,
  });
  return { actOnSessionShell, getTerminalRuntime, listSessionShells, prepareSessionShell };
}

function resource(overrides: Partial<SessionShellResource> = {}): SessionShellResource {
  return {
    resourceId,
    kind: "session-shell",
    state: "attached",
    pty: "requested-unconfirmed",
    canResize: true,
    canKill: true,
    createdAt: "2026-08-10T01:00:00.000Z",
    lastActivityAt: "2026-08-10T01:01:00.000Z",
    metrics: {
      bytesFromRenderer: "0",
      bytesToRenderer: "0",
      framesFromRenderer: "0",
      framesToRenderer: "0",
      queuedInputBytes: 0,
      queuedOutputBytes: 0,
      inFlightInputBytes: 0,
      inputCreditBytes: 65_536,
      outputCreditBytes: 65_536,
      highWaterInputBytes: 0,
      highWaterOutputBytes: 0,
      pressure: "normal",
      createdAt: "2026-08-10T01:00:00.000Z",
      lastActivityAt: "2026-08-10T01:01:00.000Z",
    },
    ...overrides,
  };
}

function inventory(resources: readonly SessionShellResource[]): SessionShellResourceList {
  return {
    resources,
    metrics: {
      activeStreams: resources.filter((candidate) => candidate.state !== "closing").length,
      attachedStreams: resources.filter((candidate) => candidate.state === "attached").length,
      detachedStreams: resources.filter((candidate) => candidate.state === "detached").length,
      reservedBytes: resources.length * 512 * 1_024,
      queuedBytes: 0,
      inFlightBytes: 0,
      highWaterReservedBytes: resources.length * 512 * 1_024,
      highWaterQueuedBytes: 0,
      highWaterInFlightBytes: 0,
      openedStreams: String(resources.length),
      rejectedStreams: "0",
      closedStreams: "0",
      closesByReason: {},
    },
  };
}

function plan(overrides: Partial<SessionShellPlan> = {}): SessionShellPlan {
  return {
    resourceId,
    kind: "session-shell",
    pty: "requested-unconfirmed",
    canResize: true,
    createdAt: "2026-08-10T01:00:00.000Z",
    attachment: {
      attachmentToken,
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
    },
    ...overrides,
  };
}

function runtimeResult() {
  return {
    ok: true,
    value: {
      version: "0.4.0",
      sha256: "d6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a",
      bytes: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    },
  };
}

function attachedSnapshot(): SessionShellTransportSnapshot {
  return {
    state: "attached",
    pressure: "normal",
    queuedInputBytes: 0,
    queuedOutputBytes: 0,
    inputCreditBytes: 65_536,
    bytesFromRemote: "0",
    bytesToRemote: "0",
  };
}

function fakeTransport() {
  let snapshot = attachedSnapshot();
  let stateListener: ((next: SessionShellTransportSnapshot) => void) | undefined;
  let terminalSubscription: {
    onOutput: (bytes: Uint8Array) => void;
    onClose: (reason?: string) => void;
  } | undefined;
  const detach = vi.fn();
  const close = vi.fn();
  const sentFrames: Array<{ bytes: Uint8Array; source: string }> = [];
  const send = vi.fn((bytes: Uint8Array, source: string) => {
    sentFrames.push({ bytes: bytes.slice(), source });
  });
  const api = {
    getSnapshot: vi.fn(() => snapshot),
    subscribeState: vi.fn((listener: (next: SessionShellTransportSnapshot) => void) => {
      stateListener = listener;
      listener(snapshot);
      return vi.fn(() => {
        if (stateListener === listener) stateListener = undefined;
      });
    }),
    detach,
    close,
    subscribe: vi.fn((subscription: typeof terminalSubscription) => {
      terminalSubscription = subscription;
      return vi.fn(() => {
        if (terminalSubscription === subscription) terminalSubscription = undefined;
      });
    }),
    send,
    resize: vi.fn(),
  } as unknown as SessionShellTransport;
  return {
    api,
    close,
    detach,
    send,
    sentFrames,
    emit(next: SessionShellTransportSnapshot) {
      snapshot = next;
      stateListener?.(next);
    },
    emitOutput(text: string) {
      terminalSubscription?.onOutput(new TextEncoder().encode(text));
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function setViewport(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }),
  });
}
