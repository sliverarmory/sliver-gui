import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { disconnectedSnapshot, type SliverDesktopAPI, type SliverSnapshot } from "../../../shared/contracts";
import type { TargetOperationRecord } from "../../../shared/operation-contracts";
import type { SessionSummary, TargetActionPlan, TargetRef } from "../../../shared/target-contracts";
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
const backend = { configId: "config-1", configName: "Example", server: "192.0.2.1:31337", operator: "alice", epoch: 7, sharedWindowCount: 1 };

function snapshot(active = false): SliverSnapshot {
  const value = disconnectedSnapshot();
  value.connection = { status: "connected", managedServer: null, epoch: 7, incarnation: 1, server: backend.server, configName: backend.configName };
  value.eventStream.status = "connected";
  value.domains.sessions = { status: "ready", revision: 1, updatedAt: new Date().toISOString(), items: [session], page: { limit: 500, total: 1, truncated: false } };
  value.targetContext = { ...value.targetContext, selectableTargets: [target],
    ...(active ? { status: "selected", activeTarget: target, activeTargetSummary: session,
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

type TestAPI = Pick<SliverDesktopAPI, "selectTarget" | "prepareTargetAction" | "executeTargetActionPlan" | "submitTargetOperation" | "refresh">;

function setup(overrides: Partial<TestAPI> = {}, initial = snapshot()) {
  const api = {
    selectTarget: vi.fn<TestAPI["selectTarget"]>().mockResolvedValue({ ok: true, value: snapshot(true) }),
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
  let actions: ApplicationContextMenuAction[] = [];
  function Harness({ value }: { value: SliverSnapshot }) {
    const context = useSessionContextActions({ snapshot: value, onSnapshot });
    actions = context.actionsForTarget(target);
    return <>{actions.map((action) => <button key={action.id} disabled={action.isDisabled}
      onClick={() => { void action.onAction(); }}>Context {action.label}</button>)}{context.dialogs}</>;
  }
  const onSnapshot = vi.fn((value: SliverSnapshot) => rendered.rerender(<Harness value={value} />));
  const rendered = render(<Harness value={initial} />);
  return { ...rendered, api, onSnapshot, actions: () => actions,
    update: (value: SliverSnapshot) => rendered.rerender(<Harness value={value} />) };
}

describe("session context action definitions", () => {
  it("keeps the table's labels, ordering, capabilities, and session-only scope", () => {
    const onAction = vi.fn();
    const options = { target, activeTarget: target, capabilities: snapshot(true).targetContext.capabilities, disabled: false, onAction };
    expect(sessionContextMenuActions(options).map(({ id, label }) => [id, label])).toEqual([
      ["session.rename", "Rename"], ["session.close", "Close Session"], ["session.kill", "Kill Session"],
    ]);
    expect(sessionContextMenuActions({ ...options, capabilities: [] }).map(({ isDisabled }) => isDisabled)).toEqual([false, true, true]);
    expect(sessionContextMenuActions({ ...options, activeTarget: null, capabilities: [] }).every(({ isDisabled }) => !isDisabled)).toBe(true);
    expect(sessionContextMenuActions({ ...options, target: { ...target, mode: "beacon" } })).toEqual([]);
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe("session context actions", () => {
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
    const oldAction = test.actions()[1]!;
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
