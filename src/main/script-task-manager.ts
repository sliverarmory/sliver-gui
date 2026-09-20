import type { OperationResult } from "../shared/contracts.js";
import {
  EMPTY_SCRIPT_TASK_SNAPSHOT,
  SCRIPT_TASK_IPC,
  SCRIPT_TASK_LIMITS,
  type ScriptTaskCommand,
  type ScriptTaskManagerSnapshot,
} from "../shared/script-task-manager-contracts.js";

interface ScriptTaskHost {
  managerId?: number;
  ready: boolean;
  snapshot: ScriptTaskManagerSnapshot;
  pendingCommands: ScriptTaskCommand[];
}

/** Main relays display data and fixed commands; execution stays in the owner's worker. */
export class ScriptTaskManagerRelay {
  readonly #hosts = new Map<number, ScriptTaskHost>();
  readonly #ownersByManager = new Map<number, number>();

  constructor(private readonly send: (contentsId: number, channel: string, ...payload: unknown[]) => void) {}

  registerOwner(ownerId: number): void {
    if (!this.#hosts.has(ownerId)) this.#hosts.set(ownerId, { ready: false, snapshot: EMPTY_SCRIPT_TASK_SNAPSHOT, pendingCommands: [] });
  }

  attachManager(ownerId: number, managerId: number): void {
    const host = this.#host(ownerId);
    if (host.managerId !== undefined && host.managerId !== managerId) throw new Error("A Script Task Manager already exists");
    host.managerId = managerId;
    this.#ownersByManager.set(managerId, ownerId);
    this.send(ownerId, SCRIPT_TASK_IPC.hostRequested);
  }

  ownerForManager(managerId: number): number | undefined { return this.#ownersByManager.get(managerId); }
  managerForOwner(ownerId: number): number | undefined { return this.#hosts.get(ownerId)?.managerId; }

  detachManager(managerId: number): void {
    const ownerId = this.#ownersByManager.get(managerId);
    if (ownerId === undefined) return;
    this.#ownersByManager.delete(managerId);
    const host = this.#hosts.get(ownerId);
    if (host?.managerId === managerId) {
      delete host.managerId;
      host.pendingCommands.length = 0;
    }
  }

  removeOwner(ownerId: number): number | undefined {
    const managerId = this.#hosts.get(ownerId)?.managerId;
    if (managerId !== undefined) this.#ownersByManager.delete(managerId);
    this.#hosts.delete(ownerId);
    return managerId;
  }

  getState(ownerId: number): ScriptTaskManagerSnapshot { return this.#host(ownerId).snapshot; }

  publish(ownerId: number, snapshot: ScriptTaskManagerSnapshot): void {
    const host = this.#host(ownerId);
    host.snapshot = snapshot;
    if (host.managerId !== undefined) this.send(host.managerId, SCRIPT_TASK_IPC.changed, snapshot);
  }

  ownerReady(ownerId: number): void {
    const host = this.#host(ownerId);
    host.ready = true;
    const queued = host.pendingCommands.splice(0);
    for (const command of queued) {
      if (host.snapshot.scripts.some((script) => script.id === command.id)) this.send(ownerId, SCRIPT_TASK_IPC.commandRequested, command);
    }
  }

  command(managerId: number, command: ScriptTaskCommand): OperationResult {
    const ownerId = this.#ownersByManager.get(managerId);
    if (ownerId === undefined) return { ok: false, error: "Script Task Manager is no longer attached" };
    const host = this.#host(ownerId);
    if (!host.snapshot.scripts.some((script) => script.id === command.id)) return { ok: false, error: "Script is no longer available" };
    if (!host.ready) {
      if (host.pendingCommands.length >= SCRIPT_TASK_LIMITS.pendingCommands) return { ok: false, error: "Script Task Manager is busy starting" };
      host.pendingCommands.push(command);
      this.send(ownerId, SCRIPT_TASK_IPC.hostRequested);
    } else this.send(ownerId, SCRIPT_TASK_IPC.commandRequested, command);
    return { ok: true };
  }

  requestEdit(ownerId: number, id: string): void {
    this.#host(ownerId);
    this.send(ownerId, SCRIPT_TASK_IPC.hostRequested);
    this.send(ownerId, SCRIPT_TASK_IPC.editRequested, id);
  }

  #host(ownerId: number): ScriptTaskHost {
    const host = this.#hosts.get(ownerId);
    if (!host) throw new Error("Script workspace is no longer available");
    return host;
  }
}
