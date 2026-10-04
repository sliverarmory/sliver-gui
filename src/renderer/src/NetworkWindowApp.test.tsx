import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toast, toast } from "@heroui/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../shared/application-settings-contracts";
import type { OperationResult } from "../../shared/contracts";
import {
  NETWORK_FORWARDING_DEFAULTS,
  type NetworkForwardingAPI,
  type NetworkForwardingSnapshot,
  type NetworkPortForwardSummary,
  type NetworkReversePortForwardSummary,
  type NetworkSessionEntry,
  type NetworkSocks5ProxySummary,
  type NetworkTabId,
  type NetworkWindowContext,
} from "../../shared/network-forwarding-contracts";
import { NetworkWindowApp } from "./NetworkWindowApp";

const session: NetworkSessionEntry = {
  session: {
    liveness: "active",
    id: "session-1",
    name: "range-workstation",
    hostname: "WIN-RANGE",
    username: "operator",
    os: "windows",
    arch: "amd64",
  },
  ref: {
    mode: "session",
    id: "session-1",
    backendEpoch: 7,
    domainRevision: 12,
    fingerprint: "f".repeat(64),
  },
};

const secondSession: NetworkSessionEntry = {
  session: {
    liveness: "active",
    id: "session-2",
    name: "linux-pivot",
    hostname: "pivot-02",
    username: "root",
    os: "linux",
    arch: "amd64",
  },
  ref: {
    mode: "session",
    id: "session-2",
    backendEpoch: 7,
    domainRevision: 12,
    fingerprint: "e".repeat(64),
  },
};

const context: NetworkWindowContext = {
  connection: {
    managedServer: null,
    status: "connected",
    operator: "moloch",
    server: "range.example:31337",
    epoch: 7,
    incarnation: 2,
  },
  sessions: {
    status: "ready",
    items: [session],
    updatedAt: "2026-09-08T18:00:00.000Z",
  },
};

const emptySnapshot: NetworkForwardingSnapshot = {
  portForwards: [],
  reversePortForwards: {
    status: "ready",
    items: [],
  },
  socks5Proxies: [],
  updatedAt: "2026-09-08T18:00:00.000Z",
};

const portForward: NetworkPortForwardSummary = {
  kind: "port-forward",
  id: "237a16fa-8865-4c6d-a732-57f573c62e99",
  sessionId: session.session.id,
  bind: { host: "127.0.0.1", port: 49152 },
  destination: { host: "127.0.0.1", port: 80 },
  state: {
    status: "listening",
    activeConnections: 0,
    totalConnections: 0,
    bytesToTarget: 0,
    bytesFromTarget: 0,
  },
  createdAt: "2026-09-08T18:01:00.000Z",
};

const reverseForward: NetworkReversePortForwardSummary = {
  kind: "reverse-port-forward",
  listenerId: 41,
  sessionId: session.session.id,
  bind: { host: "0.0.0.0", port: 8080 },
  destination: { host: "127.0.0.1", port: 8443 },
  status: "listening",
};

const socks5Proxy: NetworkSocks5ProxySummary = {
  kind: "socks5",
  id: "socks5-6dfce32e-fbd4-4215-b481-e3f034b089ed",
  sessionId: session.session.id,
  bind: { host: "127.0.0.1", port: 1080 },
  authentication: "username-password",
  state: {
    status: "listening",
    activeConnections: 0,
    totalConnections: 0,
    bytesToTarget: 0,
    bytesFromTarget: 0,
  },
  createdAt: "2026-09-08T18:02:00.000Z",
};

let currentSnapshot: NetworkForwardingSnapshot;
let currentContext: NetworkWindowContext;
let navigationListener: ((tab: NetworkTabId) => void) | undefined;
let changedListener: (() => void) | undefined;
const unsubscribeNavigation = vi.fn();
const unsubscribeChanged = vi.fn();

const api: NetworkForwardingAPI = {
  getContext: vi.fn(async () => ({ ok: true as const, value: currentContext })),
  list: vi.fn(async () => ({ ok: true as const, value: currentSnapshot })),
  startPortForward: vi.fn(async () => {
    currentSnapshot = { ...currentSnapshot, portForwards: [portForward] };
    return { ok: true as const, value: portForward };
  }),
  stopPortForward: vi.fn(async () => ({ ok: true as const })),
  startReversePortForward: vi.fn(async () => ({ ok: true as const, value: reverseForward })),
  stopReversePortForward: vi.fn(async () => ({ ok: true as const })),
  startSocks5Proxy: vi.fn(async () => {
    currentSnapshot = { ...currentSnapshot, socks5Proxies: [socks5Proxy] };
    return { ok: true as const, value: socks5Proxy };
  }),
  stopSocks5Proxy: vi.fn(async () => ({ ok: true as const })),
  getApplicationSettings: vi.fn(async () => DEFAULT_APPLICATION_SETTINGS_STATE),
  onChanged: vi.fn((listener) => {
    changedListener = listener;
    return unsubscribeChanged;
  }),
  onNavigationRequested: vi.fn((listener) => {
    navigationListener = listener;
    return unsubscribeNavigation;
  }),
  onApplicationSettingsChanged: vi.fn(() => () => undefined),
};

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
  Object.defineProperty(Element.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  Reflect.deleteProperty(Element.prototype, "setPointerCapture");
  Reflect.deleteProperty(Element.prototype, "releasePointerCapture");
  Reflect.deleteProperty(Element.prototype, "hasPointerCapture");
});

beforeEach(() => {
  currentSnapshot = emptySnapshot;
  currentContext = context;
  navigationListener = undefined;
  changedListener = undefined;
  unsubscribeNavigation.mockClear();
  unsubscribeChanged.mockClear();
  for (const value of Object.values(api)) {
    if (typeof value === "function" && "mockClear" in value) vi.mocked(value).mockClear();
  }
  vi.mocked(api.getContext).mockImplementation(async () => ({ ok: true as const, value: currentContext }));
  vi.mocked(api.list).mockImplementation(async () => ({ ok: true as const, value: currentSnapshot }));
  vi.mocked(api.startPortForward).mockImplementation(async () => {
    currentSnapshot = { ...currentSnapshot, portForwards: [portForward] };
    return { ok: true as const, value: portForward };
  });
  vi.mocked(api.stopPortForward).mockResolvedValue({ ok: true as const });
  vi.mocked(api.startReversePortForward).mockResolvedValue({ ok: true as const, value: reverseForward });
  vi.mocked(api.stopReversePortForward).mockResolvedValue({ ok: true as const });
  vi.mocked(api.startSocks5Proxy).mockImplementation(async () => {
    currentSnapshot = { ...currentSnapshot, socks5Proxies: [socks5Proxy] };
    return { ok: true as const, value: socks5Proxy };
  });
  vi.mocked(api.stopSocks5Proxy).mockResolvedValue({ ok: true as const });
  Object.defineProperty(window, "network", { configurable: true, value: Object.freeze(api) });
  toast.clear();
});

afterEach(() => {
  cleanup();
  toast.clear();
  Reflect.deleteProperty(window, "network");
});

function renderNetworkApp(): ReturnType<typeof render> {
  return render(
    <>
      <NetworkWindowApp />
      <Toast.Provider maxVisibleToasts={4} placement="bottom" />
    </>,
  );
}

describe("NetworkWindowApp", () => {
  it("loads the standalone inventory, routes native navigation, and releases subscriptions", async () => {
    const view = renderNetworkApp();

    expect(await screen.findByRole("heading", { name: "Network" })).toBeInTheDocument();
    expect(screen.getByText(/moloch/)).toHaveTextContent("moloch · range.example:31337");
    expect(screen.getByRole("tab", { name: /^Port Forward/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("grid", { name: "Local port forwards" })).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledWith({ reverseTargets: [session.ref] });

    act(() => navigationListener?.("socks5"));
    expect(screen.getByRole("tab", { name: /SOCKS5/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("grid", { name: "Local SOCKS5 proxies" })).toBeInTheDocument();

    act(() => changedListener?.());
    await waitFor(() => expect(api.getContext).toHaveBeenCalledTimes(2));

    view.unmount();
    expect(unsubscribeNavigation).toHaveBeenCalledOnce();
    expect(unsubscribeChanged).toHaveBeenCalledOnce();
  });

  it("serializes change-driven refreshes and coalesces them behind one reverse-list request", async () => {
    const firstList = deferred<OperationResult<NetworkForwardingSnapshot>>();
    vi.mocked(api.list)
      .mockReturnValueOnce(firstList.promise)
      .mockImplementation(async () => ({ ok: true as const, value: currentSnapshot }));
    renderNetworkApp();
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce());

    act(() => {
      changedListener?.();
      changedListener?.();
      changedListener?.();
    });
    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(api.list).toHaveBeenCalledOnce();

    await act(async () => firstList.resolve({ ok: true, value: currentSnapshot }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(api.getContext).toHaveBeenCalledTimes(2);
  });

  it("loads reverse inventory for every active session without a persistent session selector", async () => {
    currentContext = {
      ...context,
      sessions: { ...context.sessions, items: [session, secondSession] },
    };
    const secondReverseForward: NetworkReversePortForwardSummary = {
      ...reverseForward,
      listenerId: 42,
      sessionId: secondSession.session.id,
      bind: { host: "127.0.0.1", port: 9443 },
    };
    currentSnapshot = {
      ...emptySnapshot,
      reversePortForwards: {
        status: "ready",
        items: [reverseForward, secondReverseForward],
      },
    };
    const user = userEvent.setup();
    renderNetworkApp();
    await screen.findByRole("grid", { name: "Local port forwards" });
    expect(api.list).toHaveBeenCalledWith({ reverseTargets: [session.ref, secondSession.ref] });
    expect(screen.queryByRole("button", { name: /range-workstation.*Session/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /^Reverse Port Forward/i }));
    expect(await screen.findByText("#41")).toBeInTheDocument();
    expect(await screen.findByText("#42")).toBeInTheDocument();
    expect(screen.getByText("linux-pivot")).toBeInTheDocument();
  });

  it("selects the session inside the add modal and starts with bounded defaults", async () => {
    currentContext = {
      ...context,
      sessions: { ...context.sessions, items: [session, secondSession] },
    };
    const user = userEvent.setup();
    renderNetworkApp();
    await screen.findByRole("grid", { name: "Local port forwards" });

    const create = screen.getByRole("button", { name: "Add port forward" });
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    expect(screen.getByRole("heading", { name: "Port Forward" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /range-workstation.*Session/i }));
    await user.click(await screen.findByRole("option", { name: /linux-pivot/i }));
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(api.startPortForward).toHaveBeenCalledWith({
      session: secondSession.ref,
      bind: { host: NETWORK_FORWARDING_DEFAULTS.localBindHost, port: 0 },
      destination: { host: "127.0.0.1", port: 80 },
      keepAliveSeconds: NETWORK_FORWARDING_DEFAULTS.keepAliveSeconds,
      connectTimeoutSeconds: NETWORK_FORWARDING_DEFAULTS.connectTimeoutSeconds,
      closeTimeoutSeconds: NETWORK_FORWARDING_DEFAULTS.closeTimeoutSeconds,
      maxConnections: NETWORK_FORWARDING_DEFAULTS.portForwardConnections,
      maxBufferedBytesPerConnection: NETWORK_FORWARDING_DEFAULTS.portForwardBufferBytes,
    }));
    expect((await screen.findAllByText("127.0.0.1:49152")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Port Forward" })).not.toBeInTheDocument();
  });

  it("submits SOCKS5 authentication once and removes the password field after success", async () => {
    const user = userEvent.setup();
    renderNetworkApp();
    await screen.findByRole("grid", { name: "Local port forwards" });
    act(() => navigationListener?.("socks5"));

    await user.click(screen.getByRole("button", { name: "Add SOCKS5 proxy" }));
    const bindHost = screen.getByRole("textbox", { name: "Local bind host" });
    await user.clear(bindHost);
    await user.type(bindHost, "0.0.0.0");
    expect(screen.getByText("Unauthenticated network exposure")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: /Require authentication/i }));
    expect(screen.queryByText("Unauthenticated network exposure")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Username" }), "proxy-user");
    const password = screen.getByLabelText("Password");
    await user.type(password, "single-use-secret");
    await user.click(screen.getByRole("switch", { name: /Require authentication/i }));
    await user.click(screen.getByRole("switch", { name: /Require authentication/i }));
    expect(screen.getByRole("textbox", { name: "Username" })).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await user.type(screen.getByRole("textbox", { name: "Username" }), "proxy-user");
    await user.type(screen.getByLabelText("Password"), "single-use-secret");
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(api.startSocks5Proxy).toHaveBeenCalledWith(expect.objectContaining({
      session: session.ref,
      authentication: { username: "proxy-user", password: "single-use-secret" },
    })));
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(await screen.findByText("Username + password")).toBeInTheDocument();
    expect(screen.queryByText("single-use-secret")).not.toBeInTheDocument();
  });

  it("renders stop actions with the danger-soft background and without a mismatched pinned cell", async () => {
    currentSnapshot = { ...emptySnapshot, portForwards: [portForward] };
    renderNetworkApp();

    const stop = await screen.findByRole("button", { name: /^Stop port forward/ });
    expect(stop).toHaveClass("button--danger-soft");
    expect(stop.closest("td")).not.toHaveAttribute("data-pinned");
  });

  it("stops a reverse listener with its selected-session identity guard", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      reversePortForwards: {
        status: "ready",
        items: [reverseForward],
      },
    };
    const user = userEvent.setup();
    renderNetworkApp();
    await screen.findByRole("grid", { name: "Local port forwards" });
    await user.click(screen.getByRole("tab", { name: /Reverse Port Forward/i }));
    await user.click(screen.getByRole("button", { name: /^Stop reverse port forward/ }));
    expect(screen.getByRole("alertdialog", { name: "Stop reverse listener #41?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop forward" }));

    await waitFor(() => expect(api.stopReversePortForward).toHaveBeenCalledWith({
      session: session.ref,
      listenerId: reverseForward.listenerId,
      expectedBind: reverseForward.bind,
      expectedDestination: reverseForward.destination,
    }));
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
