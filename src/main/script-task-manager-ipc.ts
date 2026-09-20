import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import type { ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import type { OperationResult } from "../shared/contracts.js";
import { parseScriptTaskCommand, parseScriptTaskSnapshot, SCRIPT_TASK_IPC } from "../shared/script-task-manager-contracts.js";
import type { TrustedWindowIdentity } from "./ipc.js";
import { isSameRendererDocument } from "./security.js";
import { loadTerminalRuntime } from "./terminal-runtime.js";
import type { ScriptTaskManagerRelay } from "./script-task-manager.js";

export interface ScriptTaskSender { readonly role: "owner" | "manager"; readonly ownerId: number; readonly identity: TrustedWindowIdentity }
interface ScriptTaskIpcServices {
  readonly relay: ScriptTaskManagerRelay;
  readonly workspaceUrl: string;
  readonly managerUrl: string;
  readonly authorize: (window: BrowserWindow, identity: TrustedWindowIdentity) => Omit<ScriptTaskSender, "identity"> | undefined;
  readonly open: (window: BrowserWindow) => Promise<OperationResult>;
  readonly settings: () => ApplicationSettingsState;
}

const CHANNELS = [SCRIPT_TASK_IPC.open, SCRIPT_TASK_IPC.getState, SCRIPT_TASK_IPC.publish, SCRIPT_TASK_IPC.command,
  SCRIPT_TASK_IPC.ownerReady, SCRIPT_TASK_IPC.getTerminalRuntime, SCRIPT_TASK_IPC.getApplicationSettings];

export function registerScriptTaskManagerIpc(services: ScriptTaskIpcServices): void {
  for (const channel of CHANNELS) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try {
        const { window, identity, role, ownerId } = requireSender(event, services);
        if (channel === SCRIPT_TASK_IPC.publish) {
          if (role !== "owner" || args.length !== 1) throw new Error("Invalid script task publication");
          services.relay.publish(ownerId, parseScriptTaskSnapshot(args[0]));
          return { ok: true };
        }
        if (channel === SCRIPT_TASK_IPC.command) {
          if (role !== "manager" || args.length !== 1) throw new Error("Invalid script task command sender");
          return services.relay.command(identity.contentsId, parseScriptTaskCommand(args[0]));
        }
        if (args.length !== 0) throw new Error("Unexpected script task arguments");
        switch (channel) {
          case SCRIPT_TASK_IPC.open: return await services.open(window);
          case SCRIPT_TASK_IPC.getState: return { ok: true, value: services.relay.getState(ownerId) };
          case SCRIPT_TASK_IPC.ownerReady:
            if (role !== "owner") throw new Error("Only the workspace may host scripts");
            services.relay.ownerReady(ownerId);
            return { ok: true };
          case SCRIPT_TASK_IPC.getTerminalRuntime: return { ok: true, value: await loadTerminalRuntime() };
          case SCRIPT_TASK_IPC.getApplicationSettings: return services.settings();
        }
      } catch {
        return { ok: false, error: "The Script Task Manager request was rejected" };
      }
    });
  }
}

export function unregisterScriptTaskManagerIpc(): void { for (const channel of CHANNELS) ipcMain.removeHandler(channel); }

function requireSender(event: IpcMainInvokeEvent, services: ScriptTaskIpcServices): ScriptTaskSender & { window: BrowserWindow } {
  const { sender, senderFrame } = event;
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || window.isDestroyed() || sender.isDestroyed() || !senderFrame || senderFrame.isDestroyed()) throw new Error("Unknown script window");
  const mainFrame = sender.mainFrame;
  const identity = { contentsId: sender.id, rendererProcessId: senderFrame.processId, rendererFrameToken: senderFrame.frameToken };
  if (mainFrame.isDestroyed() || mainFrame.processId !== identity.rendererProcessId || mainFrame.frameToken !== identity.rendererFrameToken) throw new Error("Script tasks require the main frame");
  const authorization = services.authorize(window, identity);
  if (!authorization) throw new Error("Unknown script window");
  const expectedUrl = authorization.role === "owner" ? services.workspaceUrl : services.managerUrl;
  if (!isSameRendererDocument(sender.getURL(), expectedUrl) || !isSameRendererDocument(senderFrame.url, expectedUrl)) throw new Error("Untrusted script document");
  return { window, identity, ...authorization };
}
