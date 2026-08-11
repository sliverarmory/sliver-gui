import { contextBridge, ipcRenderer } from "electron";

import {
  IPC,
  IPC_INVOKE,
  type SliverDesktopAPI,
  type SliverDesktopInvokeAPI,
  type SliverSnapshot,
} from "../shared/contracts.js";
import type { TargetOperationRecord } from "../shared/operation-contracts.js";
import {
  STREAM_PROTOCOL_VERSION,
  isOpaqueStreamId,
  parseStreamAttachRequest,
} from "../shared/stream-contracts.js";
import type { TargetRef } from "../shared/target-contracts.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface RendererWindowBridge {
  postMessage(message: unknown, targetOrigin: string, transfer: MessagePort[]): void;
}

function openStream(attachmentToken: string, correlationId: string): void {
  const request = parseStreamAttachRequest({
    v: STREAM_PROTOCOL_VERSION,
    attachmentToken,
  });
  if (typeof correlationId !== "string" || !UUID_V4_PATTERN.test(correlationId)) {
    throw new TypeError("stream correlationId must be a UUID v4");
  }

  const channel = new MessageChannel();
  try {
    ipcRenderer.postMessage(IPC.attach, request, [channel.port1]);
    rendererWindow().postMessage(
      Object.freeze({
        source: "sliver-preload",
        type: "stream-port",
        v: STREAM_PROTOCOL_VERSION,
        correlationId,
      }),
      "*",
      [channel.port2],
    );
  } catch (error) {
    closePort(channel.port1);
    closePort(channel.port2);
    throw error;
  }
}

function rendererWindow(): RendererWindowBridge {
  const candidate = (globalThis as { window?: unknown }).window;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("postMessage" in candidate) ||
    typeof candidate.postMessage !== "function"
  ) {
    throw new Error("renderer window bridge is unavailable");
  }
  return candidate as RendererWindowBridge;
}

function closePort(port: MessagePort): void {
  try {
    port.close();
  } catch {
    // A transferred port may already be detached from this realm.
  }
}

function createInvokeApi(): SliverDesktopInvokeAPI {
  // Generate routes from the shared method-to-channel map so methods cannot be
  // wired to a different same-signature channel. Electron leaves invoke results
  // unconstrained, so keep the transport assertion isolated in this adapter.
  return Object.fromEntries(
    Object.entries(IPC_INVOKE).map(([method, channel]) => [
      method,
      (...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
    ]),
  ) as SliverDesktopInvokeAPI;
}

const api: SliverDesktopAPI = {
  ...createInvokeApi(),
  openStream,
  onSnapshotChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: SliverSnapshot) => listener(snapshot);
    ipcRenderer.on(IPC.snapshotChanged, handler);
    return () => ipcRenderer.removeListener(IPC.snapshotChanged, handler);
  },
  onOperationChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, operation: TargetOperationRecord) => listener(operation);
    ipcRenderer.on(IPC.operationChanged, handler);
    return () => ipcRenderer.removeListener(IPC.operationChanged, handler);
  },
  onBeaconTasksInvalidated: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, target: TargetRef) => listener(target);
    ipcRenderer.on(IPC.beaconTasksInvalidated, handler);
    return () => ipcRenderer.removeListener(IPC.beaconTasksInvalidated, handler);
  },
  onSessionShellsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, preferredResourceId?: unknown) => {
      if (
        preferredResourceId === undefined ||
        (typeof preferredResourceId === "string" && isOpaqueStreamId(preferredResourceId))
      ) listener(preferredResourceId);
    };
    ipcRenderer.on(IPC.sessionShellsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.sessionShellsChanged, handler);
  },
};

contextBridge.exposeInMainWorld("sliver", Object.freeze(api));
