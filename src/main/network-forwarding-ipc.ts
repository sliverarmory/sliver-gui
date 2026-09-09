import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";

import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
  type ApplicationSettingsState,
} from "../shared/application-settings-contracts.js";
import type { OperationResult } from "../shared/contracts.js";
import {
  NETWORK_FORWARDING_IPC_INVOKE,
  parseListNetworkForwardsInput,
  parsePortForwardId,
  parseSocks5ProxyId,
  parseStartPortForwardInput,
  parseStartReversePortForwardInput,
  parseStartSocks5ProxyInput,
  parseStopReversePortForwardInput,
  type ListNetworkForwardsInput,
  type NetworkForwardingSnapshot,
  type NetworkPortForwardSummary,
  type NetworkReversePortForwardSummary,
  type NetworkSocks5ProxySummary,
  type NetworkWindowContext,
  type StartPortForwardInput,
  type StartReversePortForwardInput,
  type StartSocks5ProxyInput,
  type StopReversePortForwardInput,
} from "../shared/network-forwarding-contracts.js";
import type { TrustedWindowIdentity } from "./ipc.js";
import { isSameRendererDocument } from "./security.js";

type MaybePromise<T> = T | Promise<T>;

export interface NetworkForwardingIpcController {
  getContext(contentsId: number): MaybePromise<OperationResult<NetworkWindowContext>>;
  list(
    contentsId: number,
    input: ListNetworkForwardsInput,
  ): MaybePromise<OperationResult<NetworkForwardingSnapshot>>;
  startPortForward(
    contentsId: number,
    input: StartPortForwardInput,
  ): MaybePromise<OperationResult<NetworkPortForwardSummary>>;
  stopPortForward(contentsId: number, id: string): MaybePromise<OperationResult>;
  startReversePortForward(
    contentsId: number,
    input: StartReversePortForwardInput,
  ): MaybePromise<OperationResult<NetworkReversePortForwardSummary>>;
  stopReversePortForward(
    contentsId: number,
    input: StopReversePortForwardInput,
  ): MaybePromise<OperationResult>;
  startSocks5Proxy(
    contentsId: number,
    input: StartSocks5ProxyInput,
  ): MaybePromise<OperationResult<NetworkSocks5ProxySummary>>;
  stopSocks5Proxy(contentsId: number, id: string): MaybePromise<OperationResult>;
}

export interface NetworkApplicationSettingsController {
  getState(): ApplicationSettingsState;
}

export interface NetworkForwardingIpcServices {
  readonly forwarding: NetworkForwardingIpcController;
  readonly applicationSettings: NetworkApplicationSettingsController;
}

export type NetworkWindowAuthorizer = (
  identity: TrustedWindowIdentity,
  window: BrowserWindow,
) => boolean;

interface NetworkSender {
  readonly identity: TrustedWindowIdentity;
  readonly sender: WebContents;
  readonly window: BrowserWindow;
}

const REJECTED_NETWORK_OPERATION = Object.freeze({
  ok: false as const,
  error: "The Network request was rejected",
});

export function registerNetworkForwardingIpcHandlers(
  services: NetworkForwardingIpcServices,
  exactRendererUrl: string,
  authorizeWindow: NetworkWindowAuthorizer,
): void {
  handleNetwork(
    NETWORK_FORWARDING_IPC_INVOKE.getContext,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    ({ identity }) => services.forwarding.getContext(identity.contentsId),
  );
  handleNetwork(
    NETWORK_FORWARDING_IPC_INVOKE.list,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseListNetworkForwardsInput(requireSingleArgument(args))),
    ({ identity }, input) => services.forwarding.list(identity.contentsId, input),
  );
  handleNetwork(
    NETWORK_FORWARDING_IPC_INVOKE.startPortForward,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseStartPortForwardInput(requireSingleArgument(args))),
    ({ identity }, input) => services.forwarding.startPortForward(identity.contentsId, input),
  );
  handleNetwork(
    NETWORK_FORWARDING_IPC_INVOKE.stopPortForward,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parsePortForwardId(requireSingleArgument(args))),
    ({ identity }, id) => services.forwarding.stopPortForward(identity.contentsId, id),
  );
  handleNetwork(
    NETWORK_FORWARDING_IPC_INVOKE.startReversePortForward,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseStartReversePortForwardInput(requireSingleArgument(args))),
    ({ identity }, input) => services.forwarding.startReversePortForward(identity.contentsId, input),
  );
  handleNetwork(
    NETWORK_FORWARDING_IPC_INVOKE.stopReversePortForward,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseStopReversePortForwardInput(requireSingleArgument(args))),
    ({ identity }, input) => services.forwarding.stopReversePortForward(identity.contentsId, input),
  );
  handleNetwork(
    NETWORK_FORWARDING_IPC_INVOKE.startSocks5Proxy,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseStartSocks5ProxyInput(requireSingleArgument(args))),
    ({ identity }, input) => services.forwarding.startSocks5Proxy(identity.contentsId, input),
    REJECTED_NETWORK_OPERATION,
    clearRawSocks5Arguments,
  );
  handleNetwork(
    NETWORK_FORWARDING_IPC_INVOKE.stopSocks5Proxy,
    exactRendererUrl,
    authorizeWindow,
    (args) => singleArgument(parseSocks5ProxyId(requireSingleArgument(args))),
    ({ identity }, id) => services.forwarding.stopSocks5Proxy(identity.contentsId, id),
  );
  handleNetwork(
    NETWORK_FORWARDING_IPC_INVOKE.getApplicationSettings,
    exactRendererUrl,
    authorizeWindow,
    parseNoArguments,
    () => services.applicationSettings.getState(),
    DEFAULT_APPLICATION_SETTINGS_STATE,
  );
}

export function unregisterNetworkForwardingIpcHandlers(): void {
  for (const channel of Object.values(NETWORK_FORWARDING_IPC_INVOKE)) ipcMain.removeHandler(channel);
}

function handleNetwork<Args extends readonly unknown[], Result>(
  channel: string,
  exactRendererUrl: string,
  authorizeWindow: NetworkWindowAuthorizer,
  parseArguments: (args: readonly unknown[]) => Args,
  handler: (sender: NetworkSender, ...args: Args) => MaybePromise<Result>,
  rejectedResult: Result = REJECTED_NETWORK_OPERATION as Result,
  clearRawArguments?: (args: readonly unknown[]) => void,
): void {
  ipcMain.handle(channel, async (event, ...rawArguments: unknown[]) => {
    try {
      const sender = requireNetworkSender(event, exactRendererUrl, authorizeWindow);
      const args = parseArguments(rawArguments);
      return await handler(sender, ...args);
    } catch {
      return rejectedResult;
    } finally {
      clearRawArguments?.(rawArguments);
    }
  });
}

function requireNetworkSender(
  event: IpcMainInvokeEvent,
  exactRendererUrl: string,
  authorizeWindow: NetworkWindowAuthorizer,
): NetworkSender {
  const { sender, senderFrame } = event;
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || sender.isDestroyed() || !senderFrame || senderFrame.isDestroyed()) {
    throw new Error("Untrusted Network renderer");
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
  ) throw new Error("Untrusted Network renderer");
  return { identity, sender, window };
}

function parseNoArguments(args: readonly unknown[]): [] {
  if (args.length !== 0) throw new TypeError("Unexpected Network arguments");
  return [];
}

function requireSingleArgument(args: readonly unknown[]): unknown {
  if (args.length !== 1) throw new TypeError("A single Network argument is required");
  return args[0];
}

function singleArgument<T>(value: T): [T] {
  return [value];
}

function clearRawSocks5Arguments(args: readonly unknown[]): void {
  if (args.length !== 1 || typeof args[0] !== "object" || args[0] === null) return;
  const authentication = (args[0] as Record<string, unknown>)["authentication"];
  if (typeof authentication !== "object" || authentication === null) return;
  try {
    (authentication as Record<string, unknown>)["password"] = "";
  } catch {
    // Frozen payloads still become unreachable after this invocation returns.
  }
}
