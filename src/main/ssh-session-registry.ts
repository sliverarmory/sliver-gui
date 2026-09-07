import { randomBytes } from "node:crypto";

import type { OperationResult } from "../shared/contracts.js";
import {
  SSH_MAX_TABS_PER_WINDOW,
  type ManagedSshTarget,
  type SshHostKeyReview,
  type SshTabCloseResult,
  type SshTabLaunchContext,
  type SshOpenTabResult,
  type SshWindowLaunchContext,
} from "../shared/ssh-contracts.js";
import {
  ConsolePortSession,
  type ConsoleAttachmentPort,
  type ConsoleOwnerIdentity,
  type ConsolePortRuntime,
} from "./console-port-session.js";
import type { ConsoleCloseReason } from "../shared/console-contracts.js";

export interface StartedManagedSshSession {
  readonly target: ManagedSshTarget;
  readonly runtime: ConsolePortRuntime;
}

export interface ManagedSshSessionSource {
  listSshTargets(): Promise<OperationResult<readonly ManagedSshTarget[]>>;
  startSshSession(
    deploymentId: string,
  ): Promise<OperationResult<StartedManagedSshSession | SshHostKeyReview>>;
  approveSshHostKey(token: string): Promise<OperationResult<StartedManagedSshSession>>;
}

export interface SshSessionRegistryOptions {
  readonly createOpaqueId?: () => string;
  readonly platform?: NodeJS.Platform;
}

interface SshSessionRecord {
  readonly tabId: string;
  readonly target: ManagedSshTarget;
  readonly runtime: ConsolePortRuntime;
  attachment: ConsolePortSession | undefined;
}

/**
 * Owns SSH sessions independently from their renderer window. Window teardown
 * revokes only one-use MessagePort attachments; explicit tab close and app
 * shutdown are the only local actions that close the SSH runtime.
 */
export class SshSessionRegistry {
  readonly #source: ManagedSshSessionSource;
  readonly #createOpaqueId: () => string;
  readonly #shortcutModifier: "Command" | "Control";
  readonly #sessions = new Map<string, SshSessionRecord>();
  #owner: ConsoleOwnerIdentity | undefined;
  #activeTabId: string | undefined;
  #mutationChain: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(source: ManagedSshSessionSource, options: SshSessionRegistryOptions = {}) {
    this.#source = source;
    this.#createOpaqueId = options.createOpaqueId ?? defaultOpaqueId;
    this.#shortcutModifier = (options.platform ?? process.platform) === "darwin" ? "Command" : "Control";
  }

  get size(): number {
    return this.#sessions.size;
  }

  indexOf(tabId: string): number | undefined {
    const index = [...this.#sessions.keys()].indexOf(tabId);
    return index < 0 ? undefined : index;
  }

  listTargets(owner: ConsoleOwnerIdentity): Promise<OperationResult<readonly ManagedSshTarget[]>> {
    return this.#serialize(async () => {
      this.#assertOwner(owner);
      return await this.#source.listSshTargets();
    });
  }

  claim(owner: ConsoleOwnerIdentity): Promise<OperationResult<SshWindowLaunchContext>> {
    return this.#serialize(async () => {
      this.#assertActive();
      if (this.#owner) return { ok: false, error: "This SSH window has already been claimed" };
      this.#owner = Object.freeze({ ...owner });
      const contexts: SshTabLaunchContext[] = [];
      try {
        for (const record of this.#sessions.values()) contexts.push(this.#attachRecord(record, owner));
      } catch {
        await this.#detachCurrentOwner("renderer-gone");
        return { ok: false, error: "The SSH sessions could not be attached to this window" };
      }
      if (this.#activeTabId !== undefined && !this.#sessions.has(this.#activeTabId)) {
        this.#activeTabId = undefined;
      }
      this.#activeTabId ??= contexts[0]?.tabId;
      return {
        ok: true,
        value: Object.freeze({
          kind: "ssh",
          shortcutModifier: this.#shortcutModifier,
          tabs: Object.freeze(contexts),
          ...(this.#activeTabId === undefined ? {} : { activeTabId: this.#activeTabId }),
        }),
      };
    });
  }

  openTarget(
    deploymentId: string,
    owner?: ConsoleOwnerIdentity,
  ): Promise<OperationResult<SshOpenTabResult>> {
    return this.#serialize(async () => {
      this.#assertActive();
      if (owner) this.#assertOwner(owner);
      const existing = [...this.#sessions.values()].find(
        ({ target }) => target.deploymentId === deploymentId,
      );
      if (existing) {
        this.#activeTabId = existing.tabId;
        let context: SshTabLaunchContext | undefined;
        if (owner && (!existing.attachment || existing.attachment.isTerminal)) {
          const replacement = await this.#replaceAttachment(existing, owner);
          if (!replacement.ok) {
            return { ok: false, error: replacement.error ?? "The SSH session could not be reattached" };
          }
          context = replacement.value;
        }
        return {
          ok: true,
          value: Object.freeze({
            status: "opened",
            tabId: existing.tabId,
            created: false,
            ...(context === undefined ? {} : { context }),
          }),
        };
      }
      if (this.#sessions.size >= SSH_MAX_TABS_PER_WINDOW) {
        return { ok: false, error: `SSH windows support up to ${SSH_MAX_TABS_PER_WINDOW} sessions` };
      }
      const started = await this.#source.startSshSession(deploymentId);
      if (!started.ok || !started.value) {
        return { ok: false, error: started.error ?? "The SSH session could not be started" };
      }
      if (isHostKeyReview(started.value)) {
        return {
          ok: true,
          value: Object.freeze({ status: "host-key-review", review: started.value }),
        };
      }
      return await this.#adoptStartedSession(started.value, owner ?? this.#owner);
    });
  }

  approveHostKey(
    token: string,
    owner?: ConsoleOwnerIdentity,
  ): Promise<OperationResult<SshOpenTabResult>> {
    return this.#serialize(async () => {
      this.#assertActive();
      if (owner) this.#assertOwner(owner);
      if (this.#sessions.size >= SSH_MAX_TABS_PER_WINDOW) {
        return { ok: false, error: `SSH windows support up to ${SSH_MAX_TABS_PER_WINDOW} sessions` };
      }
      const started = await this.#source.approveSshHostKey(token);
      if (!started.ok || !started.value) {
        return { ok: false, error: started.error ?? "The SSH host key could not be approved" };
      }
      const existing = [...this.#sessions.values()].find(
        ({ target }) => target.deploymentId === started.value!.target.deploymentId,
      );
      if (existing) {
        await started.value.runtime.close().catch(() => undefined);
        this.#activeTabId = existing.tabId;
        return {
          ok: true,
          value: Object.freeze({ status: "opened", tabId: existing.tabId, created: false }),
        };
      }
      return await this.#adoptStartedSession(started.value, owner ?? this.#owner);
    });
  }

  async #adoptStartedSession(
    started: StartedManagedSshSession,
    owner?: ConsoleOwnerIdentity,
  ): Promise<OperationResult<SshOpenTabResult>> {
      const tabId = this.#uniqueOpaqueId();
      const record: SshSessionRecord = {
        tabId,
        target: started.target,
        runtime: started.runtime,
        attachment: undefined,
      };
      this.#sessions.set(tabId, record);
      this.#activeTabId = tabId;
      try {
        const context = owner ? this.#attachRecord(record, owner) : undefined;
        return {
          ok: true,
          value: Object.freeze({
            status: "opened",
            tabId,
            created: true,
            ...(context === undefined ? {} : { context }),
          }),
        };
      } catch {
        this.#sessions.delete(tabId);
        this.#activeTabId = this.#sessions.keys().next().value as string | undefined;
        await started.runtime.close().catch(() => undefined);
        return { ok: false, error: "The SSH session could not be attached to this window" };
      }
  }

  closeTab(
    owner: ConsoleOwnerIdentity,
    tabId: string,
  ): Promise<OperationResult<SshTabCloseResult>> {
    return this.#serialize(async () => {
      this.#assertOwner(owner);
      const record = this.#sessions.get(tabId);
      if (!record) return { ok: false, error: "The SSH tab is unavailable" };
      await record.attachment?.close("operator-close");
      record.attachment = undefined;
      await record.runtime.close().catch(() => undefined);
      this.#sessions.delete(tabId);
      if (this.#activeTabId === tabId) {
        this.#activeTabId = this.#sessions.keys().next().value as string | undefined;
      }
      return { ok: true, value: Object.freeze({ remainingTabs: this.#sessions.size }) };
    });
  }

  selectTab(owner: ConsoleOwnerIdentity, tabId: string): Promise<OperationResult> {
    return this.#serialize(async () => {
      this.#assertOwner(owner);
      if (!this.#sessions.has(tabId)) return { ok: false, error: "The SSH tab is unavailable" };
      this.#activeTabId = tabId;
      return { ok: true };
    });
  }

  reattachTab(
    owner: ConsoleOwnerIdentity,
    tabId: string,
  ): Promise<OperationResult<SshTabLaunchContext>> {
    return this.#serialize(async () => {
      this.#assertOwner(owner);
      const record = this.#sessions.get(tabId);
      if (!record) return { ok: false, error: "The SSH tab is unavailable" };
      return await this.#replaceAttachment(record, owner);
    });
  }

  attach(
    owner: ConsoleOwnerIdentity,
    attachmentToken: string,
    port: ConsoleAttachmentPort,
  ): void {
    this.#assertOwner(owner);
    const record = [...this.#sessions.values()].find(
      ({ attachment }) => attachment?.attachmentToken === attachmentToken,
    );
    if (!record?.attachment) {
      port.close();
      throw new Error("The SSH stream capability is unavailable for this renderer");
    }
    record.attachment.attach(owner, attachmentToken, port);
  }

  detach(owner: ConsoleOwnerIdentity, reason: Extract<ConsoleCloseReason, "window-closed" | "renderer-gone" | "navigation">): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#owner || !sameOwner(this.#owner, owner)) return;
      await this.#detachCurrentOwner(reason);
    });
  }

  dispose(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#disposed) return;
      this.#disposed = true;
      if (this.#owner) await this.#detachCurrentOwner("window-closed");
      const records = [...this.#sessions.values()];
      this.#sessions.clear();
      this.#activeTabId = undefined;
      await Promise.allSettled(records.map(({ runtime }) => runtime.close()));
    });
  }

  #attachRecord(record: SshSessionRecord, owner: ConsoleOwnerIdentity): SshTabLaunchContext {
    if (record.attachment) throw new Error("SSH session already has a renderer attachment");
    const attachment = new ConsolePortSession(record.runtime, owner, {
      createOpaqueId: this.#createOpaqueId,
      closeRuntimeOnSessionClose: false,
    });
    record.attachment = attachment;
    return Object.freeze({
      tabId: record.tabId,
      attachmentToken: attachment.attachmentToken,
      target: record.target,
    });
  }

  async #replaceAttachment(
    record: SshSessionRecord,
    owner: ConsoleOwnerIdentity,
  ): Promise<OperationResult<SshTabLaunchContext>> {
    const staleAttachment = record.attachment;
    record.attachment = undefined;
    await staleAttachment?.close("renderer-gone");
    try {
      return { ok: true, value: this.#attachRecord(record, owner) };
    } catch {
      return { ok: false, error: "The SSH session could not be reattached" };
    }
  }

  async #detachCurrentOwner(reason: ConsoleCloseReason): Promise<void> {
    const attachments = [...this.#sessions.values()].flatMap((record) => {
      const attachment = record.attachment;
      record.attachment = undefined;
      return attachment ? [attachment] : [];
    });
    this.#owner = undefined;
    await Promise.allSettled(attachments.map((attachment) => attachment.close(reason)));
  }

  #assertOwner(owner: ConsoleOwnerIdentity): void {
    this.#assertActive();
    if (!this.#owner || !sameOwner(this.#owner, owner)) {
      throw new Error("This renderer is not authorized to manage SSH sessions");
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("The SSH session registry is closed");
  }

  #uniqueOpaqueId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#createOpaqueId();
      if (/^[A-Za-z0-9_-]{43}$/u.test(id) && !this.#sessions.has(id)) return id;
    }
    throw new Error("SSH session identity generation failed");
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationChain.then(operation);
    this.#mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isHostKeyReview(
  value: StartedManagedSshSession | SshHostKeyReview,
): value is SshHostKeyReview {
  return "fingerprint" in value && "token" in value;
}

function defaultOpaqueId(): string {
  return randomBytes(32).toString("base64url");
}

function sameOwner(left: ConsoleOwnerIdentity, right: ConsoleOwnerIdentity): boolean {
  return left.contentsId === right.contentsId &&
    left.rendererProcessId === right.rendererProcessId &&
    left.rendererFrameToken === right.rendererFrameToken;
}
