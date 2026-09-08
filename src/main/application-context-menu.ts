import { randomUUID } from "node:crypto";

import {
  BrowserWindow,
  clipboard,
  ipcMain,
  shell,
  type ContextMenuParams,
  type Event,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
  type WebContentsDidStartNavigationEventParams,
  type WebFrameMain,
} from "electron";

import {
  APPLICATION_CONTEXT_MENU_IPC,
  APPLICATION_CONTEXT_MENU_MAX_LABEL_LENGTH,
  APPLICATION_CONTEXT_MENU_VERSION,
  parseApplicationContextMenuActionRequest,
  parseApplicationContextMenuRequest,
  parseApplicationContextMenuVisibilityRequest,
  type ApplicationContextMenuActionItem,
  type ApplicationContextMenuItem,
  type ApplicationContextMenuItemKind,
  type ApplicationContextMenuRequest,
  type ApplicationContextMenuShortcut,
} from "../shared/application-context-menu-contracts.js";

export const APPLICATION_CONTEXT_MENU_CAPABILITY_TTL_MS = 15_000 as const;
export const APPLICATION_CONTEXT_MENU_RESTRICTED_TARGET_TTL_MS = 500 as const;
export const APPLICATION_CONTEXT_MENU_VISIBLE_LEASE_TTL_MS = 30 * 60_000;

type CapabilityAction = () => void | Promise<void>;

interface PendingMenuCapabilities {
  readonly requestId: string;
  readonly rendererProcessId: number;
  readonly rendererFrameToken: string;
  readonly actions: ReadonlyMap<string, CapabilityAction>;
  readonly visibleLeaseExpiresAt: number;
  readonly visibleLeaseTimer: NodeJS.Timeout;
  acquisitionExpiresAt?: number;
  acquisitionTimer?: NodeJS.Timeout;
}

interface InstalledWebContents {
  readonly webContents: WebContents;
  readonly onContextMenu: (event: Event, params: ContextMenuParams) => void;
  readonly onDestroyed: () => void;
  readonly onDidStartNavigation: (
    event: Event<WebContentsDidStartNavigationEventParams>,
  ) => void;
  restrictedTargetExpiresAt?: number;
  pending?: PendingMenuCapabilities;
}

interface ActionItemInput {
  readonly kind: ApplicationContextMenuItemKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly shortcut?: ApplicationContextMenuShortcut;
  readonly action: CapabilityAction;
}

interface BuiltContextMenu {
  readonly request: ApplicationContextMenuRequest;
  readonly actions: ReadonlyMap<string, CapabilityAction>;
}

/**
 * Bridges Electron's trusted native context-menu signal to the renderer's HeroUI
 * presentation. The renderer receives opaque, expiring action capabilities and
 * can never supply the text, URL, spelling replacement, or inspection coordinates.
 */
export class ApplicationContextMenuController {
  readonly #installations = new Map<number, InstalledWebContents>();
  readonly #onRestrictedTarget = (
    event: IpcMainEvent,
    ...rawArguments: unknown[]
  ): void => this.#markRestrictedTarget(event, rawArguments);
  #disposed = false;

  public constructor() {
    ipcMain.handle(
      APPLICATION_CONTEXT_MENU_IPC.executeAction,
      (event, ...rawArguments: unknown[]) => this.#executeAction(event, rawArguments),
    );
    ipcMain.handle(
      APPLICATION_CONTEXT_MENU_IPC.setOpen,
      (event, ...rawArguments: unknown[]) => this.#setOpen(event, rawArguments),
    );
    ipcMain.on(APPLICATION_CONTEXT_MENU_IPC.restrictedTarget, this.#onRestrictedTarget);
  }

  /** Installs one native context-menu listener and returns an idempotent disposer. */
  public install(webContents: WebContents): () => void {
    if (this.#disposed) throw new Error("Application context menu controller is disposed");
    if (webContents.isDestroyed()) throw new Error("Cannot install a destroyed WebContents");

    const previous = this.#installations.get(webContents.id);
    if (previous) this.#removeInstallation(previous);

    let installation: InstalledWebContents;
    const onContextMenu = (event: Event, params: ContextMenuParams): void => {
      event.preventDefault();
      this.#handleContextMenu(installation, params);
    };
    const onDestroyed = (): void => this.#removeInstallation(installation);
    const onDidStartNavigation = (
      event: Event<WebContentsDidStartNavigationEventParams>,
    ): void => {
      if (!event.isMainFrame) return;
      delete installation.restrictedTargetExpiresAt;
      this.#clearPending(installation);
    };
    installation = {
      webContents,
      onContextMenu,
      onDestroyed,
      onDidStartNavigation,
    };

    this.#installations.set(webContents.id, installation);
    webContents.on("context-menu", onContextMenu);
    webContents.on("destroyed", onDestroyed);
    webContents.on("did-start-navigation", onDidStartNavigation);

    return () => {
      if (this.#installations.get(webContents.id) === installation) {
        this.#removeInstallation(installation);
      }
    };
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    ipcMain.removeHandler(APPLICATION_CONTEXT_MENU_IPC.executeAction);
    ipcMain.removeHandler(APPLICATION_CONTEXT_MENU_IPC.setOpen);
    ipcMain.removeListener(
      APPLICATION_CONTEXT_MENU_IPC.restrictedTarget,
      this.#onRestrictedTarget,
    );
    for (const installation of [...this.#installations.values()]) {
      this.#removeInstallation(installation);
    }
  }

  #handleContextMenu(
    installation: InstalledWebContents,
    params: ContextMenuParams,
  ): void {
    const restrictedTargetExpiresAt = installation.restrictedTargetExpiresAt;
    delete installation.restrictedTargetExpiresAt;
    const restrictedTarget = restrictedTargetExpiresAt !== undefined &&
      Date.now() < restrictedTargetExpiresAt;
    const { webContents } = installation;
    if (
      this.#disposed ||
      this.#installations.get(webContents.id) !== installation ||
      webContents.isDestroyed()
    ) return;

    this.#clearPending(installation);

    let frame: WebFrameMain;
    try {
      frame = webContents.mainFrame;
      if (!isLiveMainFrame(webContents, frame)) return;
    } catch {
      return;
    }

    focusOwningWindow(webContents);
    let built: BuiltContextMenu;
    try {
      built = buildContextMenuRequest(webContents, params, restrictedTarget);
    } catch {
      return;
    }

    let pending: PendingMenuCapabilities | undefined;
    const visibleLeaseTimer = setTimeout(() => {
      if (pending && installation.pending === pending) this.#clearPending(installation);
    }, APPLICATION_CONTEXT_MENU_VISIBLE_LEASE_TTL_MS);
    const acquisitionTimer = setTimeout(() => {
      if (pending && installation.pending === pending) this.#clearPending(installation);
    }, APPLICATION_CONTEXT_MENU_CAPABILITY_TTL_MS);
    pending = {
      requestId: built.request.requestId,
      rendererProcessId: frame.processId,
      rendererFrameToken: frame.frameToken,
      actions: built.actions,
      visibleLeaseExpiresAt: Date.now() + APPLICATION_CONTEXT_MENU_VISIBLE_LEASE_TTL_MS,
      visibleLeaseTimer,
      acquisitionExpiresAt: Date.now() + APPLICATION_CONTEXT_MENU_CAPABILITY_TTL_MS,
      acquisitionTimer,
    };
    pending.acquisitionTimer?.unref();
    pending.visibleLeaseTimer.unref();
    installation.pending = pending;

    try {
      webContents.send(APPLICATION_CONTEXT_MENU_IPC.menuRequested, built.request);
    } catch {
      this.#clearPending(installation);
    }
  }

  async #executeAction(
    event: IpcMainInvokeEvent,
    rawArguments: readonly unknown[],
  ): Promise<boolean> {
    if (this.#disposed || rawArguments.length !== 1) return false;

    let request;
    try {
      request = parseApplicationContextMenuActionRequest(rawArguments[0]);
    } catch {
      return false;
    }

    const installation = this.#installedSender(event);
    if (!installation) return false;

    const pending = installation.pending;
    if (!pending || pending.requestId !== request.requestId) return false;

    if (!this.#isPendingDocument(event, pending) || this.#hasExpired(pending)) {
      this.#clearPending(installation);
      return false;
    }

    // Consume the entire menu before lookup/dispatch: a context menu represents a
    // single user choice, and invalid/disabled action IDs cannot be used as probes.
    const action = pending.actions.get(request.actionId);
    this.#clearPending(installation);
    if (!action) return false;

    try {
      await action();
      return true;
    } catch {
      return false;
    }
  }

  #setOpen(
    event: IpcMainInvokeEvent,
    rawArguments: readonly unknown[],
  ): boolean {
    if (this.#disposed || rawArguments.length !== 1) return false;

    let request;
    try {
      request = parseApplicationContextMenuVisibilityRequest(rawArguments[0]);
    } catch {
      return false;
    }

    const installation = this.#installedSender(event);
    if (!installation) return false;
    const pending = installation.pending;
    if (!pending || pending.requestId !== request.requestId) return false;

    if (!this.#isPendingDocument(event, pending) || this.#hasExpired(pending)) {
      this.#clearPending(installation);
      return false;
    }

    if (!request.open) {
      this.#clearPending(installation);
      return true;
    }

    if (pending.acquisitionTimer) clearTimeout(pending.acquisitionTimer);
    delete pending.acquisitionTimer;
    delete pending.acquisitionExpiresAt;
    return true;
  }

  #markRestrictedTarget(
    event: IpcMainEvent,
    rawArguments: readonly unknown[],
  ): void {
    if (this.#disposed || rawArguments.length !== 0) return;
    const installation = this.#installedSender(event);
    if (!installation) return;
    try {
      if (!event.senderFrame || !isLiveMainFrame(event.sender, event.senderFrame)) return;
    } catch {
      return;
    }
    installation.restrictedTargetExpiresAt = Date.now() +
      APPLICATION_CONTEXT_MENU_RESTRICTED_TARGET_TTL_MS;
  }

  #installedSender(
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): InstalledWebContents | undefined {
    const installation = this.#installations.get(event.sender.id);
    if (
      !installation ||
      installation.webContents !== event.sender ||
      event.sender.isDestroyed()
    ) return undefined;
    return installation;
  }

  #isPendingDocument(
    event: IpcMainInvokeEvent,
    pending: PendingMenuCapabilities,
  ): boolean {
    try {
      return Boolean(
        event.senderFrame &&
        event.senderFrame.processId === pending.rendererProcessId &&
        event.senderFrame.frameToken === pending.rendererFrameToken &&
        isLiveMainFrame(event.sender, event.senderFrame)
      );
    } catch {
      return false;
    }
  }

  #hasExpired(pending: PendingMenuCapabilities): boolean {
    const now = Date.now();
    return now >= pending.visibleLeaseExpiresAt || (
      pending.acquisitionExpiresAt !== undefined && now >= pending.acquisitionExpiresAt
    );
  }

  #clearPending(installation: InstalledWebContents): void {
    const pending = installation.pending;
    if (!pending) return;
    if (pending.acquisitionTimer) clearTimeout(pending.acquisitionTimer);
    clearTimeout(pending.visibleLeaseTimer);
    delete installation.pending;
  }

  #removeInstallation(installation: InstalledWebContents): void {
    if (this.#installations.get(installation.webContents.id) !== installation) return;
    this.#installations.delete(installation.webContents.id);
    this.#clearPending(installation);
    installation.webContents.removeListener("context-menu", installation.onContextMenu);
    installation.webContents.removeListener("destroyed", installation.onDestroyed);
    installation.webContents.removeListener(
      "did-start-navigation",
      installation.onDidStartNavigation,
    );
  }
}

function focusOwningWindow(webContents: WebContents): void {
  const window = BrowserWindow.fromWebContents(webContents);
  if (window && !window.isDestroyed()) window.focus();
  webContents.focus();
}

function buildContextMenuRequest(
  webContents: WebContents,
  params: ContextMenuParams,
  restrictedTarget: boolean,
): BuiltContextMenu {
  const { linkURL, x, y } = params;
  // Ghostty (and any future raw contenteditable/canvas surface) is deliberately
  // not a native text form control. Enforce its inspect-only boundary here,
  // before capabilities are minted; renderer-side filtering is presentation
  // only. Treat canvas hits as restricted even if Chromium does not inherit the
  // surrounding contenteditable state into ContextMenuParams.
  const isRestrictedSurface = restrictedTarget || params.mediaType === "canvas" ||
    (params.isEditable && params.formControlType === "none");
  const actions = new Map<string, CapabilityAction>();
  const usedActionIds = new Set<string>();
  const groups: ApplicationContextMenuItem[][] = [];

  const actionItem = ({
    kind,
    label,
    enabled,
    shortcut,
    action,
  }: ActionItemInput): ApplicationContextMenuActionItem => {
    const actionId = uniqueCapabilityId(usedActionIds);
    if (enabled) actions.set(actionId, action);
    return {
      type: "action",
      actionId,
      kind,
      label,
      enabled,
      ...(shortcut === undefined ? {} : { shortcut }),
    };
  };

  if (!isRestrictedSurface && params.isEditable && params.misspelledWord) {
    const suggestions = params.dictionarySuggestions
      .slice(0, 5)
      .filter(isSafeDynamicLabel);
    groups.push(suggestions.length > 0
      ? suggestions.map((suggestion) => actionItem({
          kind: "replace-misspelling",
          label: suggestion,
          enabled: true,
          action: () => webContents.replaceMisspelling(suggestion),
        }))
      : [actionItem({
          kind: "replace-misspelling",
          label: "No Spelling Suggestions",
          enabled: false,
          action: () => undefined,
        })]);
  }

  if (!isRestrictedSurface && params.isEditable) {
    groups.push([
      actionItem({
        kind: "undo",
        label: "Undo",
        enabled: params.editFlags.canUndo,
        shortcut: "mod+z",
        action: () => webContents.undo(),
      }),
      actionItem({
        kind: "redo",
        label: "Redo",
        enabled: params.editFlags.canRedo,
        shortcut: "mod+shift+z",
        action: () => webContents.redo(),
      }),
      { type: "separator" },
      actionItem({
        kind: "cut",
        label: "Cut",
        enabled: params.editFlags.canCut,
        shortcut: "mod+x",
        action: () => webContents.cut(),
      }),
      actionItem({
        kind: "copy",
        label: "Copy",
        enabled: params.editFlags.canCopy,
        shortcut: "mod+c",
        action: () => webContents.copy(),
      }),
      actionItem({
        kind: "paste",
        label: "Paste",
        enabled: params.editFlags.canPaste,
        shortcut: "mod+v",
        action: () => webContents.paste(),
      }),
      actionItem({
        kind: "paste-and-match-style",
        label: "Paste and Match Style",
        enabled: params.editFlags.canPaste,
        shortcut: "mod+shift+v",
        action: () => webContents.pasteAndMatchStyle(),
      }),
      actionItem({
        kind: "delete",
        label: "Delete",
        enabled: params.editFlags.canDelete,
        action: () => webContents.delete(),
      }),
      { type: "separator" },
      actionItem({
        kind: "select-all",
        label: "Select All",
        enabled: params.editFlags.canSelectAll,
        shortcut: "mod+a",
        action: () => undefined,
      }),
    ]);
  } else if (!isRestrictedSurface && params.selectionText.length > 0) {
    groups.push([
      actionItem({
        kind: "copy",
        label: "Copy",
        enabled: params.editFlags.canCopy,
        shortcut: "mod+c",
        action: () => clipboard.writeText(params.selectionText),
      }),
      actionItem({
        kind: "select-all",
        label: "Select All",
        enabled: params.editFlags.canSelectAll,
        shortcut: "mod+a",
        action: () => webContents.selectAll(),
      }),
    ]);
  } else if (!isRestrictedSurface) {
    groups.push([actionItem({
      kind: "select-all",
      label: "Select All",
      enabled: params.editFlags.canSelectAll,
      shortcut: "mod+a",
      action: () => webContents.selectAll(),
    })]);
  }

  if (!isRestrictedSurface && linkURL) {
    groups.push([
      ...(isSafeExternalWebUrl(linkURL)
        ? [actionItem({
            kind: "open-link",
            label: "Open Link in Browser",
            enabled: true,
            action: () => shell.openExternal(linkURL),
          })]
        : []),
      actionItem({
        kind: "copy-link",
        label: "Copy Link Address",
        enabled: true,
        action: () => clipboard.writeText(linkURL),
      }),
    ]);
  }

  if (
    !isRestrictedSurface &&
    params.mediaType === "image" &&
    params.hasImageContents
  ) {
    groups.push([actionItem({
      kind: "copy-image",
      label: "Copy Image",
      enabled: true,
      action: () => webContents.copyImageAt(x, y),
    })]);
  }

  groups.push([actionItem({
    kind: "inspect",
    label: "Inspect Element",
    enabled: true,
    action: () => webContents.inspectElement(x, y),
  })]);

  const request = parseApplicationContextMenuRequest({
    v: APPLICATION_CONTEXT_MENU_VERSION,
    requestId: randomUUID(),
    x,
    y,
    items: joinMenuGroups(groups),
  });
  return { request, actions };
}

function uniqueCapabilityId(used: Set<string>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = randomUUID();
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("Unable to create a unique application context menu capability");
}

function joinMenuGroups(groups: readonly (readonly ApplicationContextMenuItem[])[]): ApplicationContextMenuItem[] {
  const items: ApplicationContextMenuItem[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (items.length > 0) items.push({ type: "separator" });
    items.push(...group);
  }
  return items;
}

function isLiveMainFrame(webContents: WebContents, frame: WebFrameMain | null): frame is WebFrameMain {
  if (!frame || frame.isDestroyed() || frame.detached || frame.parent !== null) return false;
  const mainFrame = webContents.mainFrame;
  return !mainFrame.isDestroyed() &&
    !mainFrame.detached &&
    mainFrame.parent === null &&
    frame.processId === mainFrame.processId &&
    frame.frameToken === mainFrame.frameToken;
}

function isSafeDynamicLabel(value: string): boolean {
  return value.length > 0 &&
    value.length <= APPLICATION_CONTEXT_MENU_MAX_LABEL_LENGTH &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function isSafeExternalWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "";
  } catch {
    return false;
  }
}
