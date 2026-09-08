// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  SSH_MAX_TABS_PER_WINDOW,
  type ManagedSshTarget,
  type SshHostKeyReview,
} from "../shared/ssh-contracts.js";
import type {
  ConsoleAttachmentPort,
  ConsoleOwnerIdentity,
  ConsolePortRuntime,
} from "./console-port-session.js";
import {
  SshSessionRegistry,
  type ManagedSshSessionSource,
  type StartedManagedSshSession,
} from "./ssh-session-registry.js";

const ownerOne: ConsoleOwnerIdentity = {
  contentsId: 11,
  rendererProcessId: 22,
  rendererFrameToken: "frame-one",
};
const ownerTwo: ConsoleOwnerIdentity = {
  contentsId: 33,
  rendererProcessId: 44,
  rendererFrameToken: "frame-two",
};
const target: ManagedSshTarget = {
  deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0001",
  name: "test1",
  provider: "aws",
  host: "44.240.136.251",
  port: 22,
  username: "ubuntu",
  status: "running",
  connectable: true,
};

describe("SshSessionRegistry", () => {
  it("keeps the same main-owned session across window detach and reattach", async () => {
    const runtime = fakeRuntime();
    const source = fakeSource({ target, runtime });
    const ids = opaqueIds("a", "b", "c", "d", "e");
    const registry = new SshSessionRegistry(source, { createOpaqueId: () => ids.next().value!, platform: "darwin" });

    const opened = await registry.openTarget(target.deploymentId);
    expect(opened).toMatchObject({ ok: true, value: { status: "opened", created: true, tabId: "a".repeat(43) } });
    const firstClaim = await registry.claim(ownerOne);
    expect(firstClaim).toMatchObject({
      ok: true,
      value: {
        shortcutModifier: "Command",
        tabs: [{ tabId: "a".repeat(43), attachmentToken: "b".repeat(43), target }],
      },
    });

    await registry.detach(ownerOne, "window-closed");
    expect(runtime.close).not.toHaveBeenCalled();

    const secondClaim = await registry.claim(ownerTwo);
    expect(secondClaim).toMatchObject({
      ok: true,
      value: {
        tabs: [{ tabId: "a".repeat(43), attachmentToken: "d".repeat(43) }],
        activeTabId: "a".repeat(43),
      },
    });
    const closed = await registry.closeTab(ownerTwo, "a".repeat(43));
    expect(closed).toEqual({ ok: true, value: { remainingTabs: 0 } });
    expect(runtime.close).toHaveBeenCalledOnce();
    await registry.dispose();
  });

  it("focuses an existing deployment instead of starting a duplicate session", async () => {
    const runtime = fakeRuntime();
    const source = fakeSource({ target, runtime });
    const ids = opaqueIds("a");
    const registry = new SshSessionRegistry(source, { createOpaqueId: () => ids.next().value! });

    expect(await registry.openTarget(target.deploymentId)).toMatchObject({ value: { created: true } });
    expect(await registry.openTarget(target.deploymentId)).toEqual({
      ok: true,
      value: { status: "opened", tabId: "a".repeat(43), created: false },
    });
    expect(source.startSshSession).toHaveBeenCalledOnce();
    await registry.dispose();
  });

  it("creates independent tabs and runtimes for repeated explicit new-tab requests", async () => {
    const firstRuntime = fakeRuntime();
    const secondRuntime = fakeRuntime();
    const startSshSession = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { target, runtime: firstRuntime } })
      .mockResolvedValueOnce({ ok: true as const, value: { target, runtime: secondRuntime } });
    const source = {
      listSshTargets: vi.fn(async () => ({ ok: true as const, value: [target] })),
      startSshSession,
      approveSshHostKey: vi.fn(),
    } satisfies ManagedSshSessionSource;
    const ids = opaqueIds("a", "b", "c", "d", "e", "f");
    const registry = new SshSessionRegistry(source, { createOpaqueId: () => ids.next().value! });
    await registry.claim(ownerOne);

    const first = await registry.createTarget(target.deploymentId, ownerOne);
    const second = await registry.createTarget(target.deploymentId, ownerOne);

    expect(first).toMatchObject({
      ok: true,
      value: {
        status: "opened",
        created: true,
        context: { target },
      },
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        status: "opened",
        created: true,
        context: { target },
      },
    });
    if (!first.ok || first.value?.status !== "opened" ||
      !second.ok || second.value?.status !== "opened") {
      throw new Error("Expected two explicit SSH tabs");
    }
    expect(first.value.tabId).not.toBe(second.value.tabId);
    expect(first.value.context?.attachmentToken).not.toBe(second.value.context?.attachmentToken);
    expect(startSshSession.mock.calls).toEqual([
      [target.deploymentId],
      [target.deploymentId],
    ]);
    expect(registry.size).toBe(2);

    expect(await registry.closeTab(ownerOne, first.value.tabId)).toEqual({
      ok: true,
      value: { remainingTabs: 1 },
    });
    expect(firstRuntime.close).toHaveBeenCalledOnce();
    expect(secondRuntime.close).not.toHaveBeenCalled();
    expect(await registry.closeTab(ownerOne, second.value.tabId)).toEqual({
      ok: true,
      value: { remainingTabs: 0 },
    });
    expect(firstRuntime.close).toHaveBeenCalledOnce();
    expect(secondRuntime.close).toHaveBeenCalledOnce();
    await registry.dispose();
  });

  it("reuses one of two explicit same-server tabs without starting a third runtime", async () => {
    const runtimes: ReturnType<typeof fakeRuntime>[] = [];
    const startSshSession = vi.fn(async () => {
      const runtime = fakeRuntime();
      runtimes.push(runtime);
      return { ok: true as const, value: { target, runtime } };
    });
    const source = {
      listSshTargets: vi.fn(async () => ({ ok: true as const, value: [target] })),
      startSshSession,
      approveSshHostKey: vi.fn(),
    } satisfies ManagedSshSessionSource;
    const registry = new SshSessionRegistry(source, { createOpaqueId: sequentialOpaqueIds() });
    await registry.claim(ownerOne);
    const first = await registry.createTarget(target.deploymentId, ownerOne);
    const second = await registry.createTarget(target.deploymentId, ownerOne);
    if (!first.ok || first.value?.status !== "opened" ||
      !second.ok || second.value?.status !== "opened") {
      throw new Error("Expected two explicit SSH tabs");
    }

    const reused = await registry.openTarget(target.deploymentId, ownerOne);

    expect(reused).toMatchObject({
      ok: true,
      value: { status: "opened", created: false },
    });
    if (!reused.ok || reused.value?.status !== "opened") {
      throw new Error("Expected an existing SSH tab");
    }
    expect([first.value.tabId, second.value.tabId]).toContain(reused.value.tabId);
    expect(startSshSession).toHaveBeenCalledTimes(2);
    expect(runtimes).toHaveLength(2);
    expect(registry.size).toBe(2);
    await registry.dispose();
  });

  it("rejects an eleventh explicit tab before source startup but still permits reuse at capacity", async () => {
    const startSshSession = vi.fn(async () => ({
      ok: true as const,
      value: { target, runtime: fakeRuntime() },
    }));
    const source = {
      listSshTargets: vi.fn(async () => ({ ok: true as const, value: [target] })),
      startSshSession,
      approveSshHostKey: vi.fn(),
    } satisfies ManagedSshSessionSource;
    const registry = new SshSessionRegistry(source, { createOpaqueId: sequentialOpaqueIds() });
    await registry.claim(ownerOne);
    const created = await Promise.all(Array.from(
      { length: SSH_MAX_TABS_PER_WINDOW },
      () => registry.createTarget(target.deploymentId, ownerOne),
    ));
    expect(created.every((result) => result.ok && result.value?.status === "opened")).toBe(true);
    expect(registry.size).toBe(SSH_MAX_TABS_PER_WINDOW);
    expect(startSshSession).toHaveBeenCalledTimes(SSH_MAX_TABS_PER_WINDOW);

    expect(await registry.createTarget(target.deploymentId, ownerOne)).toEqual({
      ok: false,
      error: `SSH windows support up to ${SSH_MAX_TABS_PER_WINDOW} sessions`,
    });
    expect(startSshSession).toHaveBeenCalledTimes(SSH_MAX_TABS_PER_WINDOW);

    const reused = await registry.openTarget(target.deploymentId, ownerOne);
    expect(reused).toMatchObject({
      ok: true,
      value: { status: "opened", created: false },
    });
    expect(startSshSession).toHaveBeenCalledTimes(SSH_MAX_TABS_PER_WINDOW);
    expect(registry.size).toBe(SSH_MAX_TABS_PER_WINDOW);
    await registry.dispose();
  });

  it("rejects create-new host-key approval at capacity without consuming its token", async () => {
    const startSshSession = vi.fn(async () => ({
      ok: true as const,
      value: { target, runtime: fakeRuntime() },
    }));
    const approveSshHostKey = vi.fn(async () => ({
      ok: true as const,
      value: { target, runtime: fakeRuntime() },
    }));
    const source = {
      listSshTargets: vi.fn(async () => ({ ok: true as const, value: [target] })),
      startSshSession,
      approveSshHostKey,
    } satisfies ManagedSshSessionSource;
    const registry = new SshSessionRegistry(source, { createOpaqueId: sequentialOpaqueIds() });
    await registry.claim(ownerOne);
    await Promise.all(Array.from(
      { length: SSH_MAX_TABS_PER_WINDOW },
      () => registry.createTarget(target.deploymentId, ownerOne),
    ));

    expect(await registry.approveNewHostKey("r".repeat(43), ownerOne)).toEqual({
      ok: false,
      error: `SSH windows support up to ${SSH_MAX_TABS_PER_WINDOW} sessions`,
    });
    expect(approveSshHostKey).not.toHaveBeenCalled();
    expect(registry.size).toBe(SSH_MAX_TABS_PER_WINDOW);
    await registry.dispose();
  });

  it("preserves create-new intent through host-key approval when that deployment already has a tab", async () => {
    const existingRuntime = fakeRuntime();
    const approvedRuntime = fakeRuntime();
    const review: SshHostKeyReview = {
      token: "r".repeat(43),
      deploymentId: target.deploymentId,
      name: target.name,
      host: target.host,
      port: target.port,
      fingerprint: `SHA256:${"A".repeat(43)}`,
      expiresAt: "2026-09-07T19:00:00.000Z",
    };
    const startSshSession = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { target, runtime: existingRuntime } })
      .mockResolvedValueOnce({ ok: true as const, value: review });
    const approveSshHostKey = vi.fn(async () => ({
      ok: true as const,
      value: { target, runtime: approvedRuntime },
    }));
    const source = {
      listSshTargets: vi.fn(async () => ({ ok: true as const, value: [target] })),
      startSshSession,
      approveSshHostKey,
    } satisfies ManagedSshSessionSource;
    const ids = opaqueIds("a", "b", "c", "d", "e", "f");
    const registry = new SshSessionRegistry(source, { createOpaqueId: () => ids.next().value! });
    await registry.claim(ownerOne);
    const existing = await registry.openTarget(target.deploymentId, ownerOne);

    expect(await registry.createTarget(target.deploymentId, ownerOne)).toEqual({
      ok: true,
      value: { status: "host-key-review", review },
    });
    expect(registry.size).toBe(1);
    const approved = await registry.approveNewHostKey(review.token, ownerOne);

    expect(approved).toMatchObject({
      ok: true,
      value: {
        status: "opened",
        created: true,
        context: { target },
      },
    });
    if (!existing.ok || existing.value?.status !== "opened" ||
      !approved.ok || approved.value?.status !== "opened") {
      throw new Error("Expected existing and approved SSH tabs");
    }
    expect(approved.value.tabId).not.toBe(existing.value.tabId);
    expect(approveSshHostKey).toHaveBeenCalledExactlyOnceWith(review.token);
    expect(registry.size).toBe(2);
    expect(existingRuntime.close).not.toHaveBeenCalled();
    expect(approvedRuntime.close).not.toHaveBeenCalled();

    await registry.closeTab(ownerOne, existing.value.tabId);
    expect(existingRuntime.close).toHaveBeenCalledOnce();
    expect(approvedRuntime.close).not.toHaveBeenCalled();
    await registry.closeTab(ownerOne, approved.value.tabId);
    expect(approvedRuntime.close).toHaveBeenCalledOnce();
    await registry.dispose();
  });

  it("attaches a main-initiated tab to an already claimed SSH window", async () => {
    const runtime = fakeRuntime();
    const source = fakeSource({ target, runtime });
    const ids = opaqueIds("a", "b", "c");
    const registry = new SshSessionRegistry(source, { createOpaqueId: () => ids.next().value! });
    await registry.claim(ownerOne);

    const opened = await registry.openTarget(target.deploymentId);

    expect(opened).toMatchObject({
      ok: true,
      value: {
        status: "opened",
        created: true,
        tabId: "a".repeat(43),
        context: {
          tabId: "a".repeat(43),
          attachmentToken: "b".repeat(43),
        },
      },
    });
    await registry.dispose();
  });

  it("reissues a renderer attachment without closing the persisted SSH runtime", async () => {
    const runtime = fakeRuntime();
    const source = fakeSource({ target, runtime });
    const ids = opaqueIds("a", "b", "c", "d", "e");
    const registry = new SshSessionRegistry(source, { createOpaqueId: () => ids.next().value! });
    await registry.openTarget(target.deploymentId);
    await registry.claim(ownerOne);

    const replacement = await registry.reattachTab(ownerOne, "a".repeat(43));

    expect(replacement).toMatchObject({
      ok: true,
      value: {
        tabId: "a".repeat(43),
        attachmentToken: "d".repeat(43),
        target,
      },
    });
    expect(runtime.close).not.toHaveBeenCalled();
    await registry.dispose();
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("returns a fresh context when a cloud-card open finds a failed attachment", async () => {
    const runtime = fakeRuntime();
    const source = fakeSource({ target, runtime });
    const ids = opaqueIds("a", "b", "c", "d", "e");
    const registry = new SshSessionRegistry(source, { createOpaqueId: () => ids.next().value! });
    await registry.openTarget(target.deploymentId);
    const claimed = await registry.claim(ownerOne);
    if (!claimed.ok || !claimed.value) throw new Error("Expected claimed SSH fixture");
    const failedPort = new FakeAttachmentPort();
    registry.attach(ownerOne, claimed.value.tabs[0]!.attachmentToken, failedPort);
    failedPort.emitClose();

    const reopened = await registry.openTarget(target.deploymentId, ownerOne);

    expect(reopened).toMatchObject({
      ok: true,
      value: {
        status: "opened",
        created: false,
        tabId: "a".repeat(43),
        context: {
          tabId: "a".repeat(43),
          attachmentToken: "d".repeat(43),
        },
      },
    });
    expect(runtime.close).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("does not create a session until an explicit host-key review is approved", async () => {
    const runtime = fakeRuntime();
    const review: SshHostKeyReview = {
      token: "r".repeat(43),
      deploymentId: target.deploymentId,
      name: target.name,
      host: target.host,
      port: target.port,
      fingerprint: `SHA256:${"A".repeat(43)}`,
      expiresAt: "2026-09-07T19:00:00.000Z",
    };
    const source = fakeSource(review, { target, runtime });
    const ids = opaqueIds("a");
    const registry = new SshSessionRegistry(source, { createOpaqueId: () => ids.next().value! });

    expect(await registry.openTarget(target.deploymentId)).toEqual({
      ok: true,
      value: { status: "host-key-review", review },
    });
    expect(registry.size).toBe(0);

    const approved = await registry.approveHostKey(review.token);
    expect(approved).toMatchObject({ ok: true, value: { status: "opened", created: true } });
    expect(source.approveSshHostKey).toHaveBeenCalledWith(review.token);
    expect(registry.size).toBe(1);
    await registry.dispose();
  });

  it("requires the exact claimed renderer identity for tab operations", async () => {
    const runtime = fakeRuntime();
    const source = fakeSource({ target, runtime });
    const ids = opaqueIds("a", "b", "c");
    const registry = new SshSessionRegistry(source, { createOpaqueId: () => ids.next().value! });
    await registry.openTarget(target.deploymentId);
    await registry.claim(ownerOne);

    await expect(registry.listTargets(ownerTwo)).rejects.toThrow("not authorized");
    await expect(registry.closeTab(ownerTwo, "a".repeat(43))).rejects.toThrow("not authorized");
    expect(runtime.close).not.toHaveBeenCalled();
    await registry.dispose();
  });
});

function fakeSource(
  initial: StartedManagedSshSession | SshHostKeyReview,
  approved: StartedManagedSshSession = initial as StartedManagedSshSession,
): ManagedSshSessionSource & {
  startSshSession: ReturnType<typeof vi.fn>;
  approveSshHostKey: ReturnType<typeof vi.fn>;
} {
  return {
    listSshTargets: vi.fn(async () => ({ ok: true as const, value: [target] })),
    startSshSession: vi.fn(async (_deploymentId: string) => ({ ok: true as const, value: initial })),
    approveSshHostKey: vi.fn(async (_token: string) => ({ ok: true as const, value: approved })),
  };
}

function fakeRuntime(): ConsolePortRuntime & { close: ReturnType<typeof vi.fn> } {
  return {
    subscribe: vi.fn(() => () => undefined),
    write: vi.fn(),
    resize: vi.fn(),
    pauseOutput: vi.fn(),
    resumeOutput: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

function *opaqueIds(...characters: string[]): Generator<string> {
  for (const character of characters) yield character.repeat(43);
}

function sequentialOpaqueIds(): () => string {
  let next = 0;
  return () => {
    const value = next.toString(36).padStart(43, "0");
    next += 1;
    return value;
  };
}

class FakeAttachmentPort implements ConsoleAttachmentPort {
  #closeListener: (() => void) | undefined;

  postMessage(): void {}
  onMessage(): () => void { return () => undefined; }
  onClose(listener: () => void): () => void {
    this.#closeListener = listener;
    return () => { this.#closeListener = undefined; };
  }
  start(): void {}
  close(): void {}
  emitClose(): void { this.#closeListener?.(); }
}
