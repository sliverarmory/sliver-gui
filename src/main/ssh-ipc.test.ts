// @vitest-environment node

import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  MessagePortMain,
  WebContents,
  WebFrameMain,
} from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import type { ConsoleAttachmentPort } from "./console-port-session.js";
import {
  SSH_IPC_EVENTS,
  SSH_IPC_INVOKE,
  registerSshIpcHandlers,
  unregisterSshIpcHandlers,
  type SshIpcServices,
  type SshSessionController,
} from "./ssh-ipc.js";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: IpcMainEvent, ...args: unknown[]) => void>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  fromWebContents: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  clipboard: { writeText: electronMocks.writeText },
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

const SSH_RENDERER_URL = "sliver://app/index.html?surface=ssh";
const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const TAB_ID = "T".repeat(43);
const TOKEN = "A".repeat(43);
const REVIEW_TOKEN = "R".repeat(43);
const RENAMED_LABEL = "Production shell";
const SSH_COMMAND = "ssh -i ~/.ssh/sliver-gui/test1 -p 22 ubuntu@203.0.113.10";
const CURRENT_WINDOW = { marker: "current-ssh-window" } as unknown as BrowserWindow;
const OTHER_WINDOW = { marker: "other-window" } as unknown as BrowserWindow;
const REJECTED = { ok: false, error: "The SSH request was rejected" };
const TARGET = Object.freeze({
  deploymentId: DEPLOYMENT_ID,
  name: "test1",
  provider: "aws" as const,
  host: "203.0.113.10",
  port: 22,
  username: "ubuntu",
  status: "running" as const,
  connectable: true,
});

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.listeners.clear();
  electronMocks.handle.mockReset();
  electronMocks.handle.mockImplementation(
    (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    },
  );
  electronMocks.removeHandler.mockReset();
  electronMocks.removeHandler.mockImplementation((channel: string) => {
    electronMocks.handlers.delete(channel);
  });
  electronMocks.on.mockReset();
  electronMocks.on.mockImplementation(
    (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => {
      electronMocks.listeners.set(channel, listener);
    },
  );
  electronMocks.removeListener.mockReset();
  electronMocks.removeListener.mockImplementation((channel: string) => {
    electronMocks.listeners.delete(channel);
  });
  electronMocks.fromWebContents.mockReset();
  electronMocks.fromWebContents.mockReturnValue(CURRENT_WINDOW);
  electronMocks.writeText.mockReset();
  electronMocks.writeText.mockResolvedValue(undefined);
});

afterEach(() => unregisterSshIpcHandlers());

describe("SSH IPC boundary", () => {
  it("registers and unregisters only the dedicated invoke and attachment channels", () => {
    registerSshIpcHandlers(servicesMock(), SSH_RENDERER_URL, authorizeCurrentWindow);

    expect([...electronMocks.handlers.keys()].sort()).toEqual(Object.values(SSH_IPC_INVOKE).sort());
    expect([...electronMocks.listeners.keys()]).toEqual([SSH_IPC_EVENTS.attach]);

    unregisterSshIpcHandlers();

    expect(electronMocks.handlers.size).toBe(0);
    expect(electronMocks.listeners.size).toBe(0);
    expect(electronMocks.removeHandler.mock.calls.map(([channel]) => channel).sort())
      .toEqual(Object.values(SSH_IPC_INVOKE).sort());
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      SSH_IPC_EVENTS.attach,
      expect.any(Function),
    );
  });

  it("forwards validated requests with the exact authorized main-frame identity", async () => {
    const services = servicesMock();
    const authorizeWindow = vi.fn(authorizeCurrentWindow);
    registerSshIpcHandlers(services, SSH_RENDERER_URL, authorizeWindow);
    const event = invokeEvent(SSH_RENDERER_URL, 77).event;

    await invoke(SSH_IPC_INVOKE.claimSshWindow, event);
    await invoke(SSH_IPC_INVOKE.listSshTargets, event);
    await invoke(SSH_IPC_INVOKE.createSshTab, event, { deploymentId: DEPLOYMENT_ID });
    await invoke(SSH_IPC_INVOKE.reattachSshTab, event, { tabId: TAB_ID });
    await invoke(SSH_IPC_INVOKE.approveSshHostKey, event, { token: REVIEW_TOKEN });
    await invoke(SSH_IPC_INVOKE.closeSshTab, event, { tabId: TAB_ID });
    await invoke(SSH_IPC_INVOKE.selectSshTab, event, { tabId: TAB_ID });
    await invoke(SSH_IPC_INVOKE.copySshCommand, event, { tabId: TAB_ID });
    await invoke(SSH_IPC_INVOKE.renameSshTab, event, { tabId: TAB_ID, label: RENAMED_LABEL });
    await invoke(SSH_IPC_INVOKE.getTerminalRuntime, event);
    await invoke(SSH_IPC_INVOKE.getApplicationSettings, event);
    await invoke(SSH_IPC_INVOKE.updateApplicationSettings, event, {
      expectedRevision: 0,
      settings: {
        theme: "dark",
        appIcon: DEFAULT_APPLICATION_SETTINGS_STATE.appIcon,
        reduceMotion: true,
        commandPaletteShortcut: "mod+shift+k",
        keyboardShortcuts: DEFAULT_APPLICATION_SETTINGS_STATE.keyboardShortcuts,
        reportScreenshotDirectory: null,
        terminal: DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
        overview: DEFAULT_APPLICATION_SETTINGS_STATE.overview,
      },
    });

    const owner = {
      contentsId: 77,
      rendererProcessId: 100,
      rendererFrameToken: "main-frame",
    };
    expect(services.sessions.claim).toHaveBeenCalledExactlyOnceWith(owner);
    expect(services.sessions.listTargets).toHaveBeenCalledExactlyOnceWith(owner);
    expect(services.sessions.createTarget).toHaveBeenCalledExactlyOnceWith(DEPLOYMENT_ID, owner);
    expect(services.sessions.reattachTab).toHaveBeenCalledExactlyOnceWith(owner, TAB_ID);
    expect(services.sessions.approveNewHostKey).toHaveBeenCalledExactlyOnceWith(REVIEW_TOKEN, owner);
    expect(services.sessions.closeTab).toHaveBeenCalledExactlyOnceWith(owner, TAB_ID);
    expect(services.sessions.selectTab).toHaveBeenCalledExactlyOnceWith(owner, TAB_ID);
    expect(services.sessions.commandForTab).toHaveBeenCalledExactlyOnceWith(owner, TAB_ID);
    expect(services.sessions.renameTab).toHaveBeenCalledExactlyOnceWith(owner, TAB_ID, RENAMED_LABEL);
    expect(services.getTerminalRuntime).toHaveBeenCalledExactlyOnceWith();
    expect(services.applicationSettings.getState).toHaveBeenCalledExactlyOnceWith();
    expect(services.applicationSettings.update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      expectedRevision: 0,
      settings: expect.objectContaining({ theme: "dark", reduceMotion: true }),
    }));
    expect(authorizeWindow).toHaveBeenCalledWith(owner, CURRENT_WINDOW);
  });

  it("copies only the main-owned command resolved for the exact authorized SSH tab", async () => {
    const commandForTab = vi.fn<SshSessionController["commandForTab"]>(() => ({
      ok: true,
      value: SSH_COMMAND,
    }));
    const services = servicesMock({ commandForTab });
    registerSshIpcHandlers(services, SSH_RENDERER_URL, authorizeCurrentWindow);
    const event = invokeEvent(SSH_RENDERER_URL, 77).event;

    await expect(invoke(
      SSH_IPC_INVOKE.copySshCommand,
      event,
      { tabId: TAB_ID },
    )).resolves.toEqual({ ok: true });

    expect(commandForTab).toHaveBeenCalledExactlyOnceWith({
      contentsId: 77,
      rendererProcessId: 100,
      rendererFrameToken: "main-frame",
    }, TAB_ID);
    expect(electronMocks.writeText).toHaveBeenCalledExactlyOnceWith(SSH_COMMAND);
  });

  it("does not touch the clipboard when the main-owned SSH tab lookup fails", async () => {
    const commandForTab = vi.fn<SshSessionController["commandForTab"]>(() => ({
      ok: false,
      error: "The SSH tab is unavailable",
    }));
    registerSshIpcHandlers(
      servicesMock({ commandForTab }),
      SSH_RENDERER_URL,
      authorizeCurrentWindow,
    );

    await expect(invoke(
      SSH_IPC_INVOKE.copySshCommand,
      invokeEvent(SSH_RENDERER_URL, 77).event,
      { tabId: TAB_ID },
    )).resolves.toEqual({ ok: false, error: "The SSH tab is unavailable" });
    expect(commandForTab).toHaveBeenCalledOnce();
    expect(electronMocks.writeText).not.toHaveBeenCalled();
  });

  it("does not copy after the requesting renderer navigates while the identity is materialized", async () => {
    let resolveCommand!: (result: { readonly ok: true; readonly value: string }) => void;
    const pendingCommand = new Promise<{ readonly ok: true; readonly value: string }>((resolve) => {
      resolveCommand = resolve;
    });
    const commandForTab = vi.fn<SshSessionController["commandForTab"]>(() => pendingCommand);
    registerSshIpcHandlers(
      servicesMock({ commandForTab }),
      SSH_RENDERER_URL,
      authorizeCurrentWindow,
    );
    const source = invokeEvent(SSH_RENDERER_URL, 77);

    const copying = invoke(
      SSH_IPC_INVOKE.copySshCommand,
      source.event,
      { tabId: TAB_ID },
    );
    await vi.waitFor(() => expect(commandForTab).toHaveBeenCalledOnce());
    (source.mainFrame as unknown as { url: string }).url = "sliver://app/index.html";
    resolveCommand({ ok: true, value: SSH_COMMAND });

    await expect(copying).resolves.toEqual(REJECTED);
    expect(electronMocks.writeText).not.toHaveBeenCalled();
  });

  it("contains clipboard failures after resolving the main-owned SSH command", async () => {
    const commandForTab = vi.fn<SshSessionController["commandForTab"]>(() => ({
      ok: true,
      value: SSH_COMMAND,
    }));
    electronMocks.writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    registerSshIpcHandlers(
      servicesMock({ commandForTab }),
      SSH_RENDERER_URL,
      authorizeCurrentWindow,
    );

    await expect(invoke(
      SSH_IPC_INVOKE.copySshCommand,
      invokeEvent(SSH_RENDERER_URL, 77).event,
      { tabId: TAB_ID },
    )).resolves.toEqual({ ok: false, error: "The SSH command could not be copied" });
    expect(commandForTab).toHaveBeenCalledOnce();
    expect(electronMocks.writeText).toHaveBeenCalledExactlyOnceWith(SSH_COMMAND);
  });

  it.each([
    ["workspace document", "sliver://app/index.html"],
    ["origin impostor", "sliver://app.evil.test/index.html?surface=ssh"],
    ["surface suffix", "sliver://app/index.html?surface=ssh-extra"],
    ["extra query state", "sliver://app/index.html?surface=ssh&admin=true"],
  ])("rejects the %s", async (_label, url) => {
    const services = servicesMock();
    registerSshIpcHandlers(services, SSH_RENDERER_URL, authorizeCurrentWindow);

    await expect(invoke(SSH_IPC_INVOKE.claimSshWindow, invokeEvent(url, 77).event))
      .resolves.toEqual(REJECTED);
    expect(services.sessions.claim).not.toHaveBeenCalled();
  });

  it("rejects child frames, destroyed senders, and stale BrowserWindows", async () => {
    const services = servicesMock();
    registerSshIpcHandlers(services, SSH_RENDERER_URL, authorizeCurrentWindow);

    const child = invokeEvent(SSH_RENDERER_URL, 77);
    Object.defineProperty(child.event, "senderFrame", {
      value: { ...child.mainFrame, frameToken: "child-frame" } as WebFrameMain,
    });
    await expect(invoke(SSH_IPC_INVOKE.claimSshWindow, child.event)).resolves.toEqual(REJECTED);

    const destroyed = invokeEvent(SSH_RENDERER_URL, 77, true);
    await expect(invoke(SSH_IPC_INVOKE.claimSshWindow, destroyed.event)).resolves.toEqual(REJECTED);

    electronMocks.fromWebContents.mockReturnValue(OTHER_WINDOW);
    await expect(invoke(SSH_IPC_INVOKE.claimSshWindow, invokeEvent(SSH_RENDERER_URL, 77).event))
      .resolves.toEqual(REJECTED);
    expect(services.sessions.claim).not.toHaveBeenCalled();
  });

  it("rejects wrong argument counts and non-exact SSH/settings inputs before dispatch", async () => {
    const services = servicesMock();
    registerSshIpcHandlers(services, SSH_RENDERER_URL, authorizeCurrentWindow);
    const event = invokeEvent(SSH_RENDERER_URL, 77).event;
    const malformed: ReadonlyArray<readonly [string, readonly unknown[]]> = [
      [SSH_IPC_INVOKE.claimSshWindow, [null]],
      [SSH_IPC_INVOKE.listSshTargets, [{ query: "test1" }]],
      [SSH_IPC_INVOKE.createSshTab, [{ deploymentId: "not-a-uuid" }]],
      [SSH_IPC_INVOKE.createSshTab, [{ deploymentId: DEPLOYMENT_ID, host: "attacker" }]],
      [SSH_IPC_INVOKE.reattachSshTab, [{ tabId: "short" }]],
      [SSH_IPC_INVOKE.approveSshHostKey, [{ token: "short" }]],
      [SSH_IPC_INVOKE.closeSshTab, [TAB_ID]],
      [SSH_IPC_INVOKE.selectSshTab, [{ tabId: TAB_ID }, "extra"]],
      [SSH_IPC_INVOKE.copySshCommand, [{ tabId: "short" }]],
      [SSH_IPC_INVOKE.copySshCommand, [{ tabId: TAB_ID, command: "ssh attacker" }]],
      [SSH_IPC_INVOKE.copySshCommand, [{ tabId: TAB_ID, privateKey: "secret" }]],
      [SSH_IPC_INVOKE.copySshCommand, [{ tabId: TAB_ID, privateKeyPath: "/tmp/key" }]],
      [SSH_IPC_INVOKE.renameSshTab, [{ tabId: TAB_ID, label: " padded " }]],
      [SSH_IPC_INVOKE.renameSshTab, [{ tabId: TAB_ID, label: RENAMED_LABEL, extra: true }]],
      [SSH_IPC_INVOKE.getTerminalRuntime, ["ghostty-vt.wasm"]],
      [SSH_IPC_INVOKE.updateApplicationSettings, [{ expectedRevision: -1, settings: {} }]],
    ];

    for (const [channel, args] of malformed) {
      await expect(invoke(channel, event, ...args)).resolves.toEqual(REJECTED);
    }
    expect(services.sessions.claim).not.toHaveBeenCalled();
    expect(services.sessions.listTargets).not.toHaveBeenCalled();
    expect(services.sessions.createTarget).not.toHaveBeenCalled();
    expect(services.sessions.reattachTab).not.toHaveBeenCalled();
    expect(services.sessions.approveNewHostKey).not.toHaveBeenCalled();
    expect(services.sessions.closeTab).not.toHaveBeenCalled();
    expect(services.sessions.selectTab).not.toHaveBeenCalled();
    expect(services.sessions.commandForTab).not.toHaveBeenCalled();
    expect(services.sessions.renameTab).not.toHaveBeenCalled();
    expect(services.getTerminalRuntime).not.toHaveBeenCalled();
    expect(services.applicationSettings.update).not.toHaveBeenCalled();
    expect(electronMocks.writeText).not.toHaveBeenCalled();
  });

  it("returns a safe default settings state when a settings read is rejected", async () => {
    const services = servicesMock();
    registerSshIpcHandlers(services, SSH_RENDERER_URL, authorizeCurrentWindow);

    await expect(invoke(
      SSH_IPC_INVOKE.getApplicationSettings,
      invokeEvent(SSH_RENDERER_URL, 77).event,
      "unexpected",
    )).resolves.toBe(DEFAULT_APPLICATION_SETTINGS_STATE);
    expect(services.applicationSettings.getState).not.toHaveBeenCalled();
  });

  it("authorizes exactly one transferred port and adapts its message lifecycle", () => {
    const attach = vi.fn<SshSessionController["attach"]>();
    const services = servicesMock({ attach });
    registerSshIpcHandlers(services, SSH_RENDERER_URL, authorizeCurrentWindow);
    const port = new TestPort();

    attachEvent(invokeEvent(SSH_RENDERER_URL, 77).event, [port], {
      v: 1,
      attachmentToken: TOKEN,
    });

    expect(attach).toHaveBeenCalledOnce();
    const [owner, attachmentToken, adapted] = attach.mock.calls[0] ?? [];
    expect(owner).toEqual({
      contentsId: 77,
      rendererProcessId: 100,
      rendererFrameToken: "main-frame",
    });
    expect(attachmentToken).toBe(TOKEN);
    const attachment = adapted as ConsoleAttachmentPort;
    const onMessage = vi.fn();
    const onClose = vi.fn();
    const removeMessage = attachment.onMessage(onMessage);
    const removeClose = attachment.onClose(onClose);
    attachment.postMessage({ type: "credit" } as never);
    attachment.start();
    port.emit("message", { data: { type: "start" } });
    port.emit("close");
    removeMessage();
    removeClose();

    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "credit" });
    expect(port.start).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledExactlyOnceWith({ type: "start" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(port.removeListener).toHaveBeenCalledTimes(2);
    expect(port.close).not.toHaveBeenCalled();
  });

  it("closes all transferred ports on malformed, unauthorized, or rejected attachments", async () => {
    const attach = vi.fn<SshSessionController["attach"]>();
    const services = servicesMock({ attach });
    registerSshIpcHandlers(services, SSH_RENDERER_URL, authorizeCurrentWindow);

    const malformed = new TestPort();
    attachEvent(invokeEvent(SSH_RENDERER_URL, 77).event, [malformed], {
      v: 1,
      attachmentToken: "short",
    });
    expect(malformed.close).toHaveBeenCalledOnce();

    const firstExtra = new TestPort();
    const secondExtra = new TestPort();
    attachEvent(invokeEvent(SSH_RENDERER_URL, 77).event, [firstExtra, secondExtra], {
      v: 1,
      attachmentToken: TOKEN,
    });
    expect(firstExtra.close).toHaveBeenCalledOnce();
    expect(secondExtra.close).toHaveBeenCalledOnce();

    electronMocks.fromWebContents.mockReturnValue(OTHER_WINDOW);
    const unauthorized = new TestPort();
    attachEvent(invokeEvent(SSH_RENDERER_URL, 77).event, [unauthorized], {
      v: 1,
      attachmentToken: TOKEN,
    });
    expect(unauthorized.close).toHaveBeenCalledOnce();
    expect(attach).not.toHaveBeenCalled();

    electronMocks.fromWebContents.mockReturnValue(CURRENT_WINDOW);
    const rejected = new TestPort();
    attach.mockImplementationOnce(async () => { throw new Error("rejected"); });
    attachEvent(invokeEvent(SSH_RENDERER_URL, 77).event, [rejected], {
      v: 1,
      attachmentToken: TOKEN,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rejected.close).toHaveBeenCalledOnce();
  });
});

class TestPort {
  readonly postMessage = vi.fn();
  readonly start = vi.fn();
  readonly close = vi.fn();
  readonly on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  });
  readonly removeListener = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    this.listeners.get(event)?.delete(listener);
  });
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function servicesMock(overrides: Partial<SshSessionController> = {}): SshIpcServices {
  const context = Object.freeze({
    tabId: TAB_ID,
    attachmentToken: TOKEN,
    label: TARGET.name,
    target: TARGET,
  });
  const sessions: SshSessionController = {
    claim: vi.fn(async () => ({
      ok: true as const,
      value: { kind: "ssh" as const, shortcutModifier: "Command" as const, tabs: [context], activeTabId: TAB_ID },
    })),
    listTargets: vi.fn(async () => ({ ok: true as const, value: [TARGET] })),
    createTarget: vi.fn(async () => ({
      ok: true as const,
      value: { status: "opened" as const, tabId: TAB_ID, created: true, context },
    })),
    reattachTab: vi.fn(async () => ({ ok: true as const, value: context })),
    approveNewHostKey: vi.fn(async () => ({
      ok: true as const,
      value: { status: "opened" as const, tabId: TAB_ID, created: true, context },
    })),
    closeTab: vi.fn(async () => ({ ok: true as const, value: { remainingTabs: 0 } })),
    selectTab: vi.fn(async () => ({ ok: true as const })),
    commandForTab: vi.fn(() => ({ ok: true as const, value: SSH_COMMAND })),
    renameTab: vi.fn(async (_owner, tabId, label) => ({
      ok: true as const,
      value: { tabId, label },
    })),
    attach: vi.fn(),
    ...overrides,
  };
  return {
    sessions,
    getTerminalRuntime: vi.fn(async () => ({
      ok: true as const,
      value: {
        version: "0.4.0" as const,
        sha256: "d6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a",
        bytes: Uint8Array.from([0x00, 0x61, 0x73, 0x6d]),
      },
    })),
    applicationSettings: {
      getState: vi.fn(() => DEFAULT_APPLICATION_SETTINGS_STATE),
      update: vi.fn(async () => ({ ok: true as const, value: DEFAULT_APPLICATION_SETTINGS_STATE })),
    },
  };
}

function authorizeCurrentWindow(_identity: unknown, window: BrowserWindow): boolean {
  return window === CURRENT_WINDOW;
}

function invokeEvent(url: string, contentsId: number, destroyed = false): {
  readonly event: IpcMainInvokeEvent;
  readonly mainFrame: WebFrameMain;
} {
  const mainFrame = {
    processId: 100,
    frameToken: "main-frame",
    url,
    isDestroyed: () => false,
  } as WebFrameMain;
  const sender = {
    id: contentsId,
    mainFrame,
    getURL: () => url,
    isDestroyed: () => destroyed,
  } as unknown as WebContents;
  const event = { sender, senderFrame: mainFrame, ports: [] } as unknown as IpcMainInvokeEvent;
  return { event, mainFrame };
}

function invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing SSH IPC handler: ${channel}`);
  return Promise.resolve(handler(event, ...args));
}

function attachEvent(
  invokeSource: IpcMainInvokeEvent,
  ports: readonly TestPort[],
  ...args: unknown[]
): void {
  const listener = electronMocks.listeners.get(SSH_IPC_EVENTS.attach);
  if (!listener) throw new Error("Missing SSH attachment listener");
  listener({
    sender: invokeSource.sender,
    senderFrame: invokeSource.senderFrame,
    ports: ports as unknown as MessagePortMain[],
  } as IpcMainEvent, ...args);
}
