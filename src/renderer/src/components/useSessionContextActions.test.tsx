import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { disconnectedSnapshot, type SliverDesktopAPI, type SliverSnapshot } from "../../../shared/contracts";
import type { TargetOperationRecord } from "../../../shared/operation-contracts";
import type { BeaconSummary, SessionSummary, TargetActionPlan, TargetMode, TargetRef } from "../../../shared/target-contracts";
import type { ApplicationContextMenuAction } from "./ApplicationContextMenu";
import { sessionContextMenuActions } from "./session-context-menu-actions";
import { useSessionContextActions } from "./useSessionContextActions";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});
afterEach(() => cleanup());
afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

const session: SessionSummary = {
  mode: "session", id: "session-1", name: "example", hostname: "example-host", hostId: "host-1", username: "alice",
  os: "linux", arch: "amd64", transport: "mtls", remoteAddress: "192.0.2.2:4444", activeC2: "mtls://192.0.2.1",
  executable: "/tmp/example", version: "1.7.6", locale: "en-US", integrity: "user", burned: false, liveness: "active",
};
const target: TargetRef = { mode: "session", id: session.id, backendEpoch: 7, domainRevision: 1, fingerprint: "a".repeat(64) };
const beacon: BeaconSummary = { ...session, mode: "beacon", id: "beacon-1", checkinStatus: "on-time" };
const beaconTarget: TargetRef = { ...target, mode: "beacon", id: beacon.id };
const backend = { configId: "config-1", configName: "Example", server: "192.0.2.1:31337", operator: "alice", epoch: 7, sharedWindowCount: 1 };

function snapshot(active = false, mode: TargetMode = "session"): SliverSnapshot {
  const value = disconnectedSnapshot();
  value.connection = { status: "connected", managedServer: null, epoch: 7, incarnation: 1, server: backend.server, configName: backend.configName };
  value.eventStream.status = "connected";
  value.domains.sessions = { status: "ready", revision: 1, updatedAt: new Date().toISOString(), items: [session], page: { limit: 500, total: 1, truncated: false } };
  if (mode === "beacon") value.domains.beacons = { ...value.domains.sessions, items: [beacon] };
  const ref = mode === "session" ? target : beaconTarget;
  value.targetContext = { ...value.targetContext, selectableTargets: [ref],
    ...(active ? { status: "selected", activeTarget: ref, activeTargetSummary: mode === "session" ? session : beacon,
      capabilities: [{ id: "target.rename", available: true }, { id: "session.close", available: true }, { id: "target.terminate", available: true }] } : {}) };
  return value;
}

function plan(actionId: "session.close" | "target.kill" = "session.close"): TargetActionPlan {
  return { token: "review-token", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    impact: { actionId, backend, targets: [session], totalTargets: 1, truncated: false, warning: "Review this session before continuing." } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

type TestAPI = Pick<SliverDesktopAPI, "selectTarget" | "prepareTargetAction" | "executeTargetActionPlan" | "submitTargetOperation" | "refresh" | "openInteractionWindow">;

function setup(overrides: Partial<TestAPI> = {}, initial = snapshot(), contextTarget = target, navigationEnabled = true) {
  const api = {
    selectTarget: vi.fn<TestAPI["selectTarget"]>().mockResolvedValue({ ok: true, value: snapshot(true, contextTarget.mode) }),
    openInteractionWindow: vi.fn<TestAPI["openInteractionWindow"]>().mockResolvedValue({ ok: true }),
    prepareTargetAction: vi.fn<TestAPI["prepareTargetAction"]>().mockResolvedValue({ ok: true, value: plan() }),
    executeTargetActionPlan: vi.fn<TestAPI["executeTargetActionPlan"]>().mockResolvedValue({ ok: true, value: {
      actionId: "session.close", partial: false,
      outcomes: [{ requestId: "result-1", ownerWindowId: 1, target: session, status: "succeeded" }],
    } }),
    submitTargetOperation: vi.fn<TestAPI["submitTargetOperation"]>(),
    refresh: vi.fn<TestAPI["refresh"]>().mockResolvedValue({ ok: true, value: snapshot(true) }),
    ...overrides,
  };
  vi.stubGlobal("sliver", api);
  const onOpenSession = vi.fn();
  const onOpenBeacon = vi.fn();
  let actions: ApplicationContextMenuAction[] = [];
  function Harness({ value }: { value: SliverSnapshot }) {
    const context = useSessionContextActions({ snapshot: value, onSnapshot,
      ...(navigationEnabled ? { onOpenSession, onOpenBeacon } : {}) });
    actions = context.actionsForTarget(contextTarget);
    return <>{actions.map((action) => <button key={action.id} disabled={action.isDisabled}
      aria-label={`Context ${action.ariaLabel ?? action.label}`}
      onClick={() => { void action.onAction(); }}>Context {action.label}</button>)}{context.dialogs}</>;
  }
  const onSnapshot = vi.fn((value: SliverSnapshot) => rendered.rerender(<Harness value={value} />));
  const rendered = render(<Harness value={initial} />);
  return { ...rendered, api, onSnapshot, onOpenSession, onOpenBeacon, actions: () => actions,
    update: (value: SliverSnapshot) => rendered.rerender(<Harness value={value} />) };
}

describe("session context action definitions", () => {
  it("places interaction entries first and keeps maintenance labels, capabilities, and session-only scope", () => {
    const onAction = vi.fn();
    const options = { target, activeTarget: target, capabilities: snapshot(true).targetContext.capabilities, disabled: false, onAction };
    expect(sessionContextMenuActions(options).map(({ id, label }) => [id, label])).toEqual([
      ["target.interact", "Interact"], ["target.interact-popout", "Interact"],
      ["session.rename", "Rename"], ["session.close", "Close Session"], ["session.kill", "Kill Session"],
    ]);
    expect(sessionContextMenuActions({ ...options, capabilities: [] }).map(({ isDisabled }) => isDisabled)).toEqual([false, false, false, true, true]);
    expect(sessionContextMenuActions({ ...options, activeTarget: null, capabilities: [] }).every(({ isDisabled }) => !isDisabled)).toBe(true);
    expect(sessionContextMenuActions({ ...options, target: beaconTarget }).map(({ id }) => id))
      .toEqual(["target.interact", "target.interact-popout"]);
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe.each(["session", "beacon"] as const)("%s interaction navigation", (mode) => {
  const ref = mode === "session" ? target : beaconTarget;
  const summary = mode === "session" ? session : beacon;

  it("opens the existing current-window view after main confirms the exact selection", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<TestAPI["selectTarget"]>>>();
    const test = setup({ selectTarget: vi.fn().mockReturnValue(pending.promise) }, snapshot(false, mode), ref);
    await user.click(screen.getByRole("button", { name: "Context Interact" }));
    expect(test.onOpenSession).not.toHaveBeenCalled();
    expect(test.onOpenBeacon).not.toHaveBeenCalled();
    await act(async () => { pending.resolve({ ok: true, value: snapshot(true, mode) }); });
    expect(test.api.selectTarget).toHaveBeenCalledExactlyOnceWith(ref);
    expect(mode === "session" ? test.onOpenSession : test.onOpenBeacon).toHaveBeenCalledExactlyOnceWith(summary, ref);
    expect(mode === "session" ? test.onOpenBeacon : test.onOpenSession).not.toHaveBeenCalled();
    expect(test.onSnapshot).toHaveBeenCalledOnce();
    expect(test.api.openInteractionWindow).not.toHaveBeenCalled();
    expect(test.api.prepareTargetAction).not.toHaveBeenCalled();
    expect(test.api.submitTargetOperation).not.toHaveBeenCalled();
  });

  it("opens the existing standalone interaction window after main confirms the exact selection", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<TestAPI["selectTarget"]>>>();
    const test = setup({ selectTarget: vi.fn().mockReturnValue(pending.promise) }, snapshot(false, mode), ref);
    await user.click(screen.getByRole("button", { name: "Context Interact in new window" }));
    expect(test.api.openInteractionWindow).not.toHaveBeenCalled();
    await act(async () => { pending.resolve({ ok: true, value: snapshot(true, mode) }); });
    expect(test.api.selectTarget).toHaveBeenCalledExactlyOnceWith(ref);
    expect(test.api.openInteractionWindow).toHaveBeenCalledExactlyOnceWith();
    expect(test.onOpenSession).not.toHaveBeenCalled();
    expect(test.onOpenBeacon).not.toHaveBeenCalled();
    expect(test.api.prepareTargetAction).not.toHaveBeenCalled();
    expect(test.api.submitTargetOperation).not.toHaveBeenCalled();
  });

  it.each(["Context Interact", "Context Interact in new window"])("ignores %s selection after the backend incarnation changes", async (label) => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<TestAPI["selectTarget"]>>>();
    const test = setup({ selectTarget: vi.fn().mockReturnValue(pending.promise) }, snapshot(false, mode), ref);
    await user.click(screen.getByRole("button", { name: label }));
    const changed = snapshot(false, mode);
    changed.connection.incarnation = 2;
    test.update(changed);
    await act(async () => { pending.resolve({ ok: true, value: snapshot(true, mode) }); });
    expect(test.api.openInteractionWindow).not.toHaveBeenCalled();
    expect(test.onOpenSession).not.toHaveBeenCalled();
    expect(test.onOpenBeacon).not.toHaveBeenCalled();
    expect(test.onSnapshot).not.toHaveBeenCalled();
  });

  it.each(["Context Interact", "Context Interact in new window"])("rejects %s when the returned selection has a different fingerprint", async (label) => {
    const user = userEvent.setup();
    const changed = snapshot(true, mode);
    changed.targetContext.activeTarget = { ...ref, fingerprint: "b".repeat(64) };
    const test = setup({ selectTarget: vi.fn().mockResolvedValue({ ok: true, value: changed }) }, snapshot(false, mode), ref);
    await user.click(screen.getByRole("button", { name: label }));
    expect(test.api.selectTarget).toHaveBeenCalledOnce();
    expect(test.api.openInteractionWindow).not.toHaveBeenCalled();
    expect(test.onOpenSession).not.toHaveBeenCalled();
    expect(test.onOpenBeacon).not.toHaveBeenCalled();
    expect(test.onSnapshot).not.toHaveBeenCalled();
  });

  it("disables current-window interaction when its navigation callback is unavailable", () => {
    setup({}, snapshot(false, mode), ref, false);
    expect(screen.getByRole("button", { name: "Context Interact" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Context Interact in new window" })).toBeEnabled();
  });
});

describe("session context actions", () => {
  it("keeps a session selection valid while only the event stream starts retrying", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<TestAPI["selectTarget"]>>>();
    const test = setup({ selectTarget: vi.fn().mockReturnValue(pending.promise) });
    await user.click(screen.getByRole("button", { name: "Context Rename" }));
    const retrying = snapshot();
    retrying.connection.status = "reconnecting";
    retrying.eventStream.status = "retrying";
    test.update(retrying);
    const confirmed = snapshot(true);
    confirmed.connection.status = "reconnecting";
    confirmed.eventStream.status = "retrying";
    await act(async () => { pending.resolve({ ok: true, value: confirmed }); });
    expect(await screen.findByRole("dialog", { name: "Rename session" })).toBeInTheDocument();
    expect(test.api.selectTarget).toHaveBeenCalledExactlyOnceWith(target);
    expect(test.api.submitTargetOperation).not.toHaveBeenCalled();
  });

  it("selects the exact session and requires the existing confirmation before sending a reviewed token", async () => {
    const user = userEvent.setup();
    const { api, onSnapshot } = setup();
    expect(api.selectTarget).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Context Close Session" }));
    const review = await screen.findByRole("dialog", { name: "Review close session" });
    expect(api.selectTarget).toHaveBeenCalledExactlyOnceWith(target);
    expect(api.prepareTargetAction).toHaveBeenCalledExactlyOnceWith({ actionId: "session.close" });
    expect(api.executeTargetActionPlan).not.toHaveBeenCalled();
    await user.click(within(review).getByRole("button", { name: "Close session" }));
    await screen.findByRole("dialog", { name: "Target action results" });
    expect(api.executeTargetActionPlan).toHaveBeenCalledExactlyOnceWith({ token: "review-token" });
    await waitFor(() => expect(api.refresh).toHaveBeenCalledOnce());
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it("reuses RenameSessionModal and refreshes the snapshot after a confirmed rename response", async () => {
    const user = userEvent.setup();
    const operation: TargetOperationRecord = {
      requestId: "rename-1", operationId: "target.rename", target, targetName: session.name, backend,
      ownership: { origin: "local", ownerWindowId: 1, actor: { attribution: "verified", name: "alice" } },
      mode: "session", state: "completed", attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const { api } = setup({ submitTargetOperation: vi.fn().mockResolvedValue({ ok: true, value: operation }) });
    await user.click(screen.getByRole("button", { name: "Context Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename session" });
    const input = within(dialog).getByRole("textbox", { name: "Session name" });
    expect(input).toHaveValue("example");
    fireEvent.change(input, { target: { value: "new-name" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(api.refresh).toHaveBeenCalledOnce());
    expect(api.submitTargetOperation).toHaveBeenCalledExactlyOnceWith({ operationId: "target.rename", name: "new-name" });
    expect(api.prepareTargetAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename session" })).not.toBeInTheDocument());
  });

  it.each(["disconnect", "replacement", "unmount"])("ignores a pending selection after %s", async (change) => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<TestAPI["selectTarget"]>>>();
    const test = setup({ selectTarget: vi.fn().mockReturnValue(pending.promise) });
    await user.click(screen.getByRole("button", { name: "Context Close Session" }));
    if (change === "unmount") test.unmount();
    else if (change === "disconnect") test.update(disconnectedSnapshot());
    else {
      const replaced = snapshot();
      replaced.targetContext.selectableTargets = [{ ...target, fingerprint: "b".repeat(64) }];
      test.update(replaced);
    }
    await act(async () => { pending.resolve({ ok: true, value: snapshot(true) }); });
    expect(test.api.prepareTargetAction).not.toHaveBeenCalled();
    expect(test.onSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("retires an already-open menu across a disconnect even if the same backend later returns", async () => {
    const test = setup();
    const oldAction = test.actions().find((action) => action.id === "session.close")!;
    test.update(disconnectedSnapshot());
    test.update(snapshot());
    await act(async () => { await oldAction.onAction(); });
    expect(test.api.selectTarget).not.toHaveBeenCalled();
  });

  it("discards an action review that completes after a connection incarnation change", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<TestAPI["prepareTargetAction"]>>>();
    const test = setup({ prepareTargetAction: vi.fn().mockReturnValue(pending.promise) });
    await user.click(screen.getByRole("button", { name: "Context Close Session" }));
    await waitFor(() => expect(test.api.prepareTargetAction).toHaveBeenCalledOnce());
    const next = snapshot(true);
    next.connection.incarnation = 2;
    test.update(next);
    await act(async () => { pending.resolve({ ok: true, value: plan() }); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(test.api.executeTargetActionPlan).not.toHaveBeenCalled();
  });

  it("rechecks capabilities after selection and rejects a review for a different session", async () => {
    const user = userEvent.setup();
    const unavailable = snapshot(true);
    unavailable.targetContext.capabilities = [{ id: "session.close", available: false }];
    const first = setup({ selectTarget: vi.fn().mockResolvedValue({ ok: true, value: unavailable }) });
    await user.click(screen.getByRole("button", { name: "Context Close Session" }));
    await waitFor(() => expect(first.onSnapshot).toHaveBeenCalledOnce());
    expect(first.api.prepareTargetAction).not.toHaveBeenCalled();
    cleanup();
    const mismatch = plan();
    mismatch.impact.targets = [{ ...session, id: "different-session" }];
    const second = setup({ prepareTargetAction: vi.fn().mockResolvedValue({ ok: true, value: mismatch }) });
    await user.click(screen.getByRole("button", { name: "Context Close Session" }));
    await waitFor(() => expect(second.api.prepareTargetAction).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(second.api.executeTargetActionPlan).not.toHaveBeenCalled();
  });

  it("removes an open rename when the active session identity changes", async () => {
    const user = userEvent.setup();
    const test = setup();
    await user.click(screen.getByRole("button", { name: "Context Rename" }));
    await screen.findByRole("dialog", { name: "Rename session" });
    const next = snapshot(true);
    next.targetContext.activeTarget = { ...target, fingerprint: "b".repeat(64) };
    test.update(next);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(test.api.submitTargetOperation).not.toHaveBeenCalled();
  });

  it("rejects an expired review without executing", async () => {
    const user = userEvent.setup();
    const expired = plan();
    expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    const test = setup({ prepareTargetAction: vi.fn().mockResolvedValue({ ok: true, value: expired }) });
    await user.click(screen.getByRole("button", { name: "Context Close Session" }));
    const dialog = await screen.findByRole("dialog", { name: "Review close session" });
    await user.click(within(dialog).getByRole("button", { name: "Close session" }));
    expect(test.api.executeTargetActionPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
