import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const shellMocks = vi.hoisted(() => ({
  open: vi.fn(),
  focus: vi.fn(),
  getSelection: vi.fn(() => "selected output"),
  paste: vi.fn(),
}));

vi.mock("../components/GhosttyTerminal", async () => {
  const React = await import("react");
  return {
    GhosttyTerminal: React.forwardRef(function MockGhosttyTerminal(
      props: { ariaLabel?: string; onError?: (error: Error) => void },
      ref: React.ForwardedRef<unknown>,
    ) {
      React.useImperativeHandle(ref, () => ({
        focus: shellMocks.focus,
        getSelection: shellMocks.getSelection,
        paste: shellMocks.paste,
      }));
      return (
        <div aria-label={props.ariaLabel} role="textbox">
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

  it("forces Windows shells to non-PTY mode without terminal dimensions", async () => {
    const windowsSession = { ...session, os: "windows", arch: "amd64" };
    shellMocks.open.mockResolvedValue(fakeTransport().api);
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
  });

  it("attaches, reports lifecycle pressure, and routes detach through the managed action API", async () => {
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
    await screen.findByText("Detached");

    await user.click(screen.getAllByRole("button", { name: "Attach" })[0]!);
    expect(await screen.findByRole("textbox", { name: "Interactive shell for payments" })).toBeInTheDocument();
    act(() => transport.emit({ ...attachedSnapshot(), pressure: "high" }));
    expect(await screen.findByText("Backpressure")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(api.actOnSessionShell).toHaveBeenCalledWith({
      resourceId,
      action: "detach",
    }));
    expect(transport.detach).toHaveBeenCalledOnce();
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
    const listSessionShells = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: inventory([resource({ state: "detached" })]) })
      .mockResolvedValue({ ok: true, value: inventory([]) });
    const api = installAPI({
      listSessionShells,
      actOnSessionShell: async (_resourceId, requestedAction) => ({
        ok: true,
        value: { action: requestedAction, resourceId },
      }),
    });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("Detached");

    await user.click(screen.getByRole("button", { name: trigger }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(heading);
    expect(dialog).toHaveTextContent(copy);
    expect(api.actOnSessionShell).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: confirm }));
    await waitFor(() => expect(api.actOnSessionShell).toHaveBeenCalledWith({ resourceId, action }));
  });

  it("requires explicit review for multiline paste and never renders clipboard payload", async () => {
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
    await screen.findByRole("textbox", { name: "Interactive shell for payments" });

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

  it("replaces the persistent list with a controlled shell sheet on narrow viewports", async () => {
    setViewport(false);
    installAPI({ listSessionShells: async () => ({ ok: true, value: inventory([resource()]) }) });
    const user = userEvent.setup();
    render(<SessionTerminalPanel route={route} session={session} />);
    await screen.findByText("Shell is not attached");

    await user.click(screen.getByRole("button", { name: "Shells" }));
    expect(await screen.findByRole("dialog", { name: "Managed Shells" })).toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
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
  const detach = vi.fn();
  const close = vi.fn();
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
    subscribe: vi.fn(() => vi.fn()),
    send: vi.fn(),
    resize: vi.fn(),
  } as unknown as SessionShellTransport;
  return {
    api,
    close,
    detach,
    emit(next: SessionShellTransportSnapshot) {
      snapshot = next;
      stateListener?.(next);
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
