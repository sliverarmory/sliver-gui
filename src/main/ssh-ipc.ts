import {
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessageEvent as ElectronMessageEvent,
  type MessagePortMain,
  type WebContents,
} from "electron";

import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
  parseApplicationSettingsUpdateInput,
  type ApplicationSettingsState,
  type ApplicationSettingsUpdateInput,
} from "../shared/application-settings-contracts.js";
import type { OperationResult } from "../shared/contracts.js";
import {
  parseSshAttachRequest,
  parseSshDeploymentInput,
  parseSshHostKeyReviewInput,
  parseSshTabInput,
  parseSshTabRenameInput,
  type ManagedSshTarget,
  type SshOpenTabResult,
  type SshTabCloseResult,
  type SshTabLaunchContext,
  type SshTabRenameResult,
  type SshWindowLaunchContext,
} from "../shared/ssh-contracts.js";
import type { TerminalRuntimeAsset } from "../shared/stream-contracts.js";
import type {
  ConsoleAttachmentPort,
  ConsoleOwnerIdentity,
} from "./console-port-session.js";
import { isSameRendererDocument } from "./security.js";
import type { TrustedWindowIdentity } from "./ipc.js";

export const SSH_IPC_INVOKE = {
  claimSshWindow: "sliver:ssh:window:claim",
  listSshTargets: "sliver:ssh:targets:list",
  createSshTab: "sliver:ssh:tab:create",
  reattachSshTab: "sliver:ssh:tab:reattach",
  approveSshHostKey: "sliver:ssh:host-key:approve",
  closeSshTab: "sliver:ssh:tab:close",
  selectSshTab: "sliver:ssh:tab:select",
  renameSshTab: "sliver:ssh:tab:rename",
  getTerminalRuntime: "sliver:ssh:terminal-runtime:get",
  getApplicationSettings: "sliver:ssh:application-settings:get",
  updateApplicationSettings: "sliver:ssh:application-settings:update",
} as const;

export const SSH_IPC_EVENTS = {
  attach: "sliver:ssh:stream:attach",
  newTabRequested: "sliver:ssh:new-tab-requested",
  closeTabRequested: "sliver:ssh:close-tab-requested",
  selectTabRequested: "sliver:ssh:select-tab-requested",
  settingsRequested: "sliver:ssh:settings-requested",
  tabOpened: "sliver:ssh:tab-opened",
  // Application settings are already broadcast to every tracked native window
  // on this channel. The dedicated preload listens narrowly without exposing
  // the rest of the workspace API.
  applicationSettingsChanged: "sliver:application-settings:changed",
} as const;

type MaybePromise<T> = T | Promise<T>;

export interface SshSessionController {
  claim(owner: ConsoleOwnerIdentity): MaybePromise<OperationResult<SshWindowLaunchContext>>;
  listTargets(owner: ConsoleOwnerIdentity): MaybePromise<OperationResult<readonly ManagedSshTarget[]>>;
  createTarget(
    deploymentId: string,
    owner: ConsoleOwnerIdentity,
  ): MaybePromise<OperationResult<SshOpenTabResult>>;
  reattachTab(
    owner: ConsoleOwnerIdentity,
    tabId: string,
  ): MaybePromise<OperationResult<SshTabLaunchContext>>;
  approveNewHostKey(
    token: string,
    owner: ConsoleOwnerIdentity,
  ): MaybePromise<OperationResult<SshOpenTabResult>>;
  closeTab(
    owner: ConsoleOwnerIdentity,
    tabId: string,
  ): MaybePromise<OperationResult<SshTabCloseResult>>;
  selectTab(owner: ConsoleOwnerIdentity, tabId: string): MaybePromise<OperationResult>;
  renameTab(
    owner: ConsoleOwnerIdentity,
    tabId: string,
    label: string,
  ): MaybePromise<OperationResult<SshTabRenameResult>>;
  attach(owner: ConsoleOwnerIdentity, attachmentToken: string, port: ConsoleAttachmentPort): MaybePromise<void>;
}

export interface SshApplicationSettingsController {
  getState(): ApplicationSettingsState;
  update(input: ApplicationSettingsUpdateInput): MaybePromise<OperationResult<ApplicationSettingsState>>;
}

export interface SshIpcServices {
  readonly sessions: SshSessionController;
  readonly getTerminalRuntime: () => MaybePromise<OperationResult<TerminalRuntimeAsset>>;
  readonly applicationSettings: SshApplicationSettingsController;
}

export type SshWindowAuthorizer = (
  identity: TrustedWindowIdentity,
  window: BrowserWindow,
) => boolean;

interface SshSender {
  readonly identity: TrustedWindowIdentity;
  readonly sender: WebContents;
  readonly window: BrowserWindow;
}

const REJECTED_SSH_OPERATION = Object.freeze({
  ok: false as const,
  error: "The SSH request was rejected",
});

let registeredSshAttachListener:
  | ((event: IpcMainEvent, ...args: unknown[]) => void)
  | undefined;

export function registerSshIpcHandlers(
  services: SshIpcServices,
  exactRendererUrl: string,
  authorizeWindow: SshWindowAuthorizer,
): void {
  handleSsh(
    SSH_IPC_INVOKE.claimSshWindow,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    ({ identity }) => services.sessions.claim(identity),
  );
  handleSsh(
    SSH_IPC_INVOKE.listSshTargets,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    ({ identity }) => services.sessions.listTargets(identity),
  );
  handleSsh(
    SSH_IPC_INVOKE.createSshTab,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseSshDeploymentInput(requireSingleArgument(args))),
    ({ identity }, input) => services.sessions.createTarget(input.deploymentId, identity),
  );
  handleSsh(
    SSH_IPC_INVOKE.reattachSshTab,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseSshTabInput(requireSingleArgument(args))),
    ({ identity }, input) => services.sessions.reattachTab(identity, input.tabId),
  );
  handleSsh(
    SSH_IPC_INVOKE.approveSshHostKey,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseSshHostKeyReviewInput(requireSingleArgument(args))),
    ({ identity }, input) => services.sessions.approveNewHostKey(input.token, identity),
  );
  handleSsh(
    SSH_IPC_INVOKE.closeSshTab,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseSshTabInput(requireSingleArgument(args))),
    ({ identity }, input) => services.sessions.closeTab(identity, input.tabId),
  );
  handleSsh(
    SSH_IPC_INVOKE.selectSshTab,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseSshTabInput(requireSingleArgument(args))),
    ({ identity }, input) => services.sessions.selectTab(identity, input.tabId),
  );
  handleSsh(
    SSH_IPC_INVOKE.renameSshTab,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseSshTabRenameInput(requireSingleArgument(args))),
    ({ identity }, input) => services.sessions.renameTab(identity, input.tabId, input.label),
  );
  handleSsh(
    SSH_IPC_INVOKE.getTerminalRuntime,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    () => services.getTerminalRuntime(),
  );
  handleSsh(
    SSH_IPC_INVOKE.getApplicationSettings,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    () => services.applicationSettings.getState(),
    DEFAULT_APPLICATION_SETTINGS_STATE,
  );
  handleSsh(
    SSH_IPC_INVOKE.updateApplicationSettings,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseApplicationSettingsUpdateInput(requireSingleArgument(args))),
    (_sender, input) => services.applicationSettings.update(input),
  );

  if (registeredSshAttachListener) {
    ipcMain.removeListener(SSH_IPC_EVENTS.attach, registeredSshAttachListener);
  }
  registeredSshAttachListener = createSshAttachListener(
    services.sessions,
    exactRendererUrl,
    authorizeWindow,
  );
  ipcMain.on(SSH_IPC_EVENTS.attach, registeredSshAttachListener);
}

export function unregisterSshIpcHandlers(): void {
  for (const channel of Object.values(SSH_IPC_INVOKE)) ipcMain.removeHandler(channel);
  if (registeredSshAttachListener) {
    ipcMain.removeListener(SSH_IPC_EVENTS.attach, registeredSshAttachListener);
    registeredSshAttachListener = undefined;
  }
}

function handleSsh<Args extends readonly unknown[], Result>(
  channel: string,
  exactRendererUrl: string,
  authorizeWindow: SshWindowAuthorizer,
  parseArguments: (args: readonly unknown[]) => Args,
  handler: (sender: SshSender, ...args: Args) => MaybePromise<Result>,
  rejectedResult: Result = REJECTED_SSH_OPERATION as Result,
): void {
  ipcMain.handle(channel, async (event, ...rawArguments: unknown[]) => {
    try {
      const sender = requireSshSender(event, exactRendererUrl, authorizeWindow);
      const args = parseArguments(rawArguments);
      return await handler(sender, ...args);
    } catch {
      return rejectedResult;
    }
  });
}

function requireSshSender(
  event: IpcMainInvokeEvent | IpcMainEvent,
  exactRendererUrl: string,
  authorizeWindow: SshWindowAuthorizer,
): SshSender {
  const { sender, senderFrame } = event;
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || sender.isDestroyed() || !senderFrame || senderFrame.isDestroyed()) {
    throw new Error("Untrusted SSH renderer");
  }
  const mainFrame = sender.mainFrame;
  const identity: TrustedWindowIdentity = {
    contentsId: sender.id,
    rendererProcessId: senderFrame.processId,
    rendererFrameToken: senderFrame.frameToken,
  };
  if (
    senderFrame.processId !== mainFrame.processId ||
    senderFrame.frameToken !== mainFrame.frameToken ||
    !isSameRendererDocument(sender.getURL(), exactRendererUrl) ||
    !isSameRendererDocument(senderFrame.url, exactRendererUrl) ||
    !authorizeWindow(identity, window)
  ) throw new Error("Untrusted SSH renderer");
  return { identity, sender, window };
}

function createSshAttachListener(
  controller: SshSessionController,
  exactRendererUrl: string,
  authorizeWindow: SshWindowAuthorizer,
): (event: IpcMainEvent, ...args: unknown[]) => void {
  return (event, ...rawArguments): void => {
    const ports = [...event.ports];
    try {
      if (ports.length !== 1) throw new Error("Rejected SSH attachment without exactly one transferred port");
      const sender = requireSshSender(event, exactRendererUrl, authorizeWindow);
      if (rawArguments.length !== 1) throw new TypeError("A single SSH attachment argument is required");
      const request = parseSshAttachRequest(rawArguments[0]);
      const result: unknown = controller.attach(
        sender.identity,
        request.attachmentToken,
        sshAttachmentPort(ports[0] as MessagePortMain),
      );
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => closeTransferredPorts(ports));
      }
    } catch {
      closeTransferredPorts(ports);
    }
  };
}

function sshAttachmentPort(port: MessagePortMain): ConsoleAttachmentPort {
  return {
    postMessage: (frame) => port.postMessage(frame),
    onMessage: (listener) => {
      const handler = (event: ElectronMessageEvent): void => listener(event.data);
      port.on("message", handler);
      return () => port.removeListener("message", handler);
    },
    onClose: (listener) => {
      port.on("close", listener);
      return () => port.removeListener("close", listener);
    },
    start: () => port.start(),
    close: () => port.close(),
  };
}

function parseNoArguments(args: readonly unknown[]): [] {
  if (args.length !== 0) throw new TypeError("Unexpected SSH arguments");
  return [];
}

function requireSingleArgument(args: readonly unknown[]): unknown {
  if (args.length !== 1) throw new TypeError("A single SSH argument is required");
  return args[0];
}

function singleArgument<T>(value: T): [T] {
  return [value];
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && "then" in value && typeof value.then === "function";
}

function closeTransferredPorts(ports: readonly MessagePortMain[]): void {
  for (const port of ports) {
    try {
      port.close();
    } catch {
      // Try every supplied port even when one host object is already detached.
    }
  }
}
